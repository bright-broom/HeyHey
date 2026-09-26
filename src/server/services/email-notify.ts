import { timingSafeEqual } from "node:crypto";
import { and, count, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { notificationPrefs, notifications, posts, users } from "../db/schema";
import { invalid } from "../lib/errors";
import { assertMember } from "../lib/policy";
import { keyedHash } from "../lib/secretbox";
import type { Viewer } from "../lib/viewer";
import { visiblePost } from "../lib/visibility";
import { appUrl, sendMail } from "./mailer";
import { stillVisible, type NotificationType } from "./notifications";

/**
 * メールでのお知らせ（F-19）。
 * メールには投稿の中身も人の名前も書かない。件数とリンクだけを送り、中身はログインして見てもらう
 * （メールは外部のサーバーに残り、転送もされる。「承認されたメンバー以外には何も見えない」を守るため）。
 * - すぐのお知らせ：メンション・コメント・返信・友達申請。同じ人には 15 分に 1 通まで、まとめて送る
 * - 週 1 回のまとめ：月曜（日本時間）の定期処理で、新しい投稿の数と未読の数を送る
 */
export const EMAIL_NOTIFICATION_TYPES: NotificationType[] = ["mention", "comment", "reply", "friend_request"];
const THROTTLE_MIN = 15;
/** これより古い未送信のお知らせは、メールにしない（機能を入れた直後に過去の分がまとめて届かないように） */
const LOOKBACK_HOURS = 24;
const DIGEST_INTERVAL_DAYS = 6;

export type EmailKind = "instant" | "digest";
export type EmailPrefs = { emailInstant: boolean; emailDigest: boolean };

// ───────── 設定 ─────────

export async function getEmailPrefs(db: Db, viewer: Viewer): Promise<EmailPrefs> {
  assertMember(viewer);
  const [row] = await db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, viewer.id));
  return { emailInstant: row?.emailInstant ?? true, emailDigest: row?.emailDigest ?? true };
}

export async function setEmailPrefs(db: Db, viewer: Viewer, prefs: EmailPrefs): Promise<void> {
  assertMember(viewer);
  await db
    .insert(notificationPrefs)
    .values({ userId: viewer.id, ...prefs })
    .onConflictDoUpdate({ target: notificationPrefs.userId, set: { ...prefs, updatedAt: new Date() } });
}

// ───────── 配信停止のリンク ─────────

const sign = (userId: string, kind: EmailKind) => keyedHash("unsubscribe", `${userId}:${kind}`).slice(0, 32);

/** メールの配信停止リンクに入れる署名付きトークン（ログインなしで、その人のその種類だけを止められる） */
export function unsubscribeToken(userId: string, kind: EmailKind): string {
  return `${userId}.${kind}.${sign(userId, kind)}`;
}

export function parseUnsubscribeToken(token: string): { userId: string; kind: EmailKind } | null {
  const [userId, kind, sig] = token.split(".");
  if (!userId || !sig || (kind !== "instant" && kind !== "digest") || !/^[0-9a-f-]{36}$/.test(userId)) return null;
  const expected = sign(userId, kind);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return { userId, kind };
}

export async function unsubscribe(db: Db, token: string): Promise<EmailKind> {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) throw invalid("配信停止のリンクが正しくありません。");
  const set = parsed.kind === "instant" ? { emailInstant: false } : { emailDigest: false };
  await db
    .insert(notificationPrefs)
    .values({ userId: parsed.userId, ...set })
    .onConflictDoUpdate({ target: notificationPrefs.userId, set: { ...set, updatedAt: new Date() } });
  return parsed.kind;
}

function footer(userId: string, kind: EmailKind): { text: string; headers: Record<string, string> } {
  const url = appUrl(`/unsubscribe/${unsubscribeToken(userId, kind)}`);
  const oneClick = appUrl(`/api/unsubscribe/${unsubscribeToken(userId, kind)}`);
  return {
    text: [
      "",
      "―",
      "このメールには、内容や人の名前を書いていません。ログインして確認してください。",
      `${kind === "instant" ? "お知らせ" : "週 1 回のまとめ"}のメールを止める：${url}`,
      `設定を変える：${appUrl("/settings")}`,
    ].join("\n"),
    // メールソフトの「配信停止」ボタン（RFC 8058 のワンクリック）
    headers: { "List-Unsubscribe": `<${oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}

/** 承認済み・規約同意済みで、ログインできる会員か */
const reachableMember = and(eq(users.status, "active"), isNotNull(users.termsAcceptedAt));

// ───────── すぐのお知らせ ─────────

/**
 * 未送信のお知らせがあれば、1 通にまとめて送る。送ったら true。
 * 15 分以内に送っていれば送らない（次のお知らせか、毎日の定期処理で送る）。
 */
export async function dispatchNotificationEmail(db: Db, userId: string, now = new Date()): Promise<boolean> {
  const [u] = await db
    .select({ email: users.email, instant: notificationPrefs.emailInstant })
    .from(users)
    .leftJoin(notificationPrefs, eq(notificationPrefs.userId, users.id))
    .where(and(eq(users.id, userId), reachableMember));
  if (!u || u.instant === false) return false;

  const pending = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        isNull(notifications.emailedAt),
        inArray(notifications.type, EMAIL_NOTIFICATION_TYPES),
        gt(notifications.createdAt, new Date(now.getTime() - LOOKBACK_HOURS * 3600_000)),
        stillVisible(userId),
      ),
    );
  if (!pending.length) return false;

  // 送信枠を原子的に確保する（同時に何件お知らせが来ても、送るのは 1 通）
  const since = new Date(now.getTime() - THROTTLE_MIN * 60_000);
  const [claimed] = await db
    .insert(notificationPrefs)
    .values({ userId, lastEmailAt: now })
    .onConflictDoUpdate({
      target: notificationPrefs.userId,
      set: { lastEmailAt: now },
      setWhere: or(isNull(notificationPrefs.lastEmailAt), lt(notificationPrefs.lastEmailAt, since)),
    })
    .returning({ userId: notificationPrefs.userId });
  if (!claimed) return false;

  await db.update(notifications).set({ emailedAt: now }).where(inArray(notifications.id, pending.map((p) => p.id)));
  const f = footer(userId, "instant");
  await sendMail(db, {
    to: u.email,
    subject: `【Kakomi】新しいお知らせが ${pending.length} 件あります`,
    body: [`Kakomi に新しいお知らせが ${pending.length} 件あります（メンション・コメント・返信・友達申請）。`, "", appUrl("/notifications"), f.text].join("\n"),
    headers: f.headers,
  });
  return true;
}

/**
 * お知らせを作った後に、応答を返してからメールを送る（Server Actions の中で呼ばれたとき）。
 * リクエストの外（テスト・スクリプト）では何もしない。そこで漏れた分は、毎日の定期処理が拾う。
 */
export async function scheduleNotificationEmail(userId: string): Promise<void> {
  try {
    const { after } = await import("next/server");
    after(async () => {
      try {
        const { getDb } = await import("../db/client");
        await dispatchNotificationEmail(await getDb(), userId);
      } catch (e) {
        console.error("[notification-email]", e);
      }
    });
  } catch {
    // リクエストの外
  }
}

/** 毎日の定期処理：送り残したお知らせを送る */
export async function dispatchPendingNotificationEmails(db: Db, now = new Date()): Promise<number> {
  const rows = await db
    .selectDistinct({ userId: notifications.userId })
    .from(notifications)
    .where(
      and(
        isNull(notifications.readAt),
        isNull(notifications.emailedAt),
        inArray(notifications.type, EMAIL_NOTIFICATION_TYPES),
        gt(notifications.createdAt, new Date(now.getTime() - LOOKBACK_HOURS * 3600_000)),
      ),
    );
  let sent = 0;
  for (const r of rows) if (await dispatchNotificationEmail(db, r.userId, now)) sent++;
  return sent;
}

// ───────── 週 1 回のまとめ ─────────

/** 日本時間の月曜日か */
export function isDigestDay(now: Date): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short" }).format(now) === "Mon";
}

/** 週 1 回のまとめを送る。新しい投稿も未読もなければ送らない。送った人数を返す */
export async function sendWeeklyDigests(db: Db, now = new Date()): Promise<number> {
  const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
  const due = new Date(now.getTime() - DIGEST_INTERVAL_DAYS * 24 * 3600_000);
  const members = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .leftJoin(notificationPrefs, eq(notificationPrefs.userId, users.id))
    .where(
      and(
        reachableMember,
        or(isNull(notificationPrefs.emailDigest), eq(notificationPrefs.emailDigest, true)),
        or(isNull(notificationPrefs.lastDigestAt), lt(notificationPrefs.lastDigestAt, due)),
      ),
    );
  let sent = 0;
  for (const m of members) {
    const [[{ n: newPosts } = { n: 0 }], [{ n: unread } = { n: 0 }]] = await Promise.all([
      db
        .select({ n: count() })
        .from(posts)
        .where(and(gt(posts.createdAt, weekAgo), ne(posts.authorId, m.id), visiblePost(m.id))),
      db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.userId, m.id), isNull(notifications.readAt), stillVisible(m.id))),
    ]);
    if (newPosts === 0 && unread === 0) continue;
    const [claimed] = await db
      .insert(notificationPrefs)
      .values({ userId: m.id, lastDigestAt: now })
      .onConflictDoUpdate({
        target: notificationPrefs.userId,
        set: { lastDigestAt: now },
        setWhere: or(isNull(notificationPrefs.lastDigestAt), lt(notificationPrefs.lastDigestAt, due)),
      })
      .returning({ userId: notificationPrefs.userId });
    if (!claimed) continue;
    const f = footer(m.id, "digest");
    await sendMail(db, {
      to: m.email,
      subject: "【Kakomi】今週のお知らせ",
      body: [
        "今週の Kakomi のようすです。",
        "",
        `・あなたが見られる新しい投稿：${newPosts} 件`,
        `・未読のお知らせ：${unread} 件`,
        "",
        appUrl("/"),
        f.text,
      ].join("\n"),
      headers: f.headers,
    });
    sent++;
  }
  return sent;
}

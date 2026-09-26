import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { mailOutbox, notifications } from "@/server/db/schema";
import { blockUser } from "@/server/services/blocks";
import {
  dispatchNotificationEmail,
  dispatchPendingNotificationEmails,
  getEmailPrefs,
  isDigestDay,
  parseUnsubscribeToken,
  sendWeeklyDigests,
  setEmailPrefs,
  unsubscribe,
  unsubscribeToken,
} from "@/server/services/email-notify";
import { addComment, createPost } from "@/server/services/posts";
import { befriend, db, makeUser, rawPost } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const mailsTo = (to: string) => d.select().from(mailOutbox).where(eq(mailOutbox.to, to)).orderBy(desc(mailOutbox.createdAt));
const MIN = 60_000;

describe("すぐのお知らせメール", () => {
  it("件数とリンクだけを送り、人の名前も投稿の中身も書かない", async () => {
    const author = await makeUser(d);
    const commenter = await makeUser(d, { displayName: "コメントした人の名前" });
    const { id } = await createPost(d, author.viewer, { body: "ないしょの投稿本文", visibility: "members" });
    await addComment(d, commenter.viewer, { postId: id, body: "ないしょのコメント本文" });
    expect(await dispatchNotificationEmail(d, author.user.id)).toBe(true);
    const [mail] = await mailsTo(author.user.email);
    expect(mail!.subject).toBe("【Kakomi】新しいお知らせが 1 件あります");
    for (const secret of ["コメントした人の名前", "ないしょの投稿本文", "ないしょのコメント本文", commenter.user.email]) {
      expect(mail!.subject + mail!.body).not.toContain(secret);
    }
    expect(mail!.body).toContain("/notifications");
    expect(mail!.body).toMatch(/\/unsubscribe\/[0-9a-f-]{36}\.instant\.[0-9a-f]{32}/);
    const [n] = await d.select().from(notifications).where(eq(notifications.userId, author.user.id));
    expect(n!.emailedAt).not.toBeNull();
  });

  it("同じ人には 15 分に 1 通まで。その後に来た分は、次の機会にまとめて送る", async () => {
    const author = await makeUser(d);
    const c = await makeUser(d);
    const { id } = await createPost(d, author.viewer, { body: "x", visibility: "members" });
    const t0 = new Date();
    await addComment(d, c.viewer, { postId: id, body: "1" });
    expect(await dispatchNotificationEmail(d, author.user.id, t0)).toBe(true);
    await addComment(d, c.viewer, { postId: id, body: "2" });
    await addComment(d, c.viewer, { postId: id, body: "3" });
    expect(await dispatchNotificationEmail(d, author.user.id, new Date(t0.getTime() + 5 * MIN))).toBe(false);
    expect(await dispatchNotificationEmail(d, author.user.id, new Date(t0.getTime() + 16 * MIN))).toBe(true);
    const mails = await mailsTo(author.user.email);
    expect(mails.map((m) => m.subject)).toEqual(["【Kakomi】新しいお知らせが 2 件あります", "【Kakomi】新しいお知らせが 1 件あります"]);
  });

  it("同時に何度呼ばれても 1 通だけ", async () => {
    const author = await makeUser(d);
    const c = await makeUser(d);
    const { id } = await createPost(d, author.viewer, { body: "x", visibility: "members" });
    await addComment(d, c.viewer, { postId: id, body: "1" });
    const results = await Promise.all(Array.from({ length: 5 }, () => dispatchNotificationEmail(d, author.user.id)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await mailsTo(author.user.email)).toHaveLength(1);
  });

  it("設定で止めた人・読み終えたお知らせ・リアクションだけの場合は送らない", async () => {
    const off = await makeUser(d);
    const c = await makeUser(d);
    await setEmailPrefs(d, off.viewer, { emailInstant: false, emailDigest: true });
    const { id } = await createPost(d, off.viewer, { body: "x", visibility: "members" });
    await addComment(d, c.viewer, { postId: id, body: "1" });
    expect(await dispatchNotificationEmail(d, off.user.id)).toBe(false);

    const reader = await makeUser(d);
    const { id: p2 } = await createPost(d, reader.viewer, { body: "x", visibility: "members" });
    await addComment(d, c.viewer, { postId: p2, body: "1" });
    await d.update(notifications).set({ readAt: new Date() }).where(eq(notifications.userId, reader.user.id));
    expect(await dispatchNotificationEmail(d, reader.user.id)).toBe(false);

    const reacted = await makeUser(d);
    await d.insert(notifications).values({ userId: reacted.user.id, type: "reaction", actorId: c.user.id });
    expect(await dispatchNotificationEmail(d, reacted.user.id)).toBe(false);
  });

  it("24 時間より前の未送信分は送らない（機能を入れた直後に過去の分が届かない）", async () => {
    const u = await makeUser(d);
    const c = await makeUser(d);
    await d.insert(notifications).values({ userId: u.user.id, type: "friend_request", actorId: c.user.id, createdAt: new Date(Date.now() - 25 * 3600_000) });
    expect(await dispatchNotificationEmail(d, u.user.id)).toBe(false);
  });

  it("後からブロックした相手のお知らせは、メールにも数えない", async () => {
    const u = await makeUser(d);
    const c = await makeUser(d);
    await d.insert(notifications).values({ userId: u.user.id, type: "friend_request", actorId: c.user.id });
    await blockUser(d, c.viewer, u.user.id);
    expect(await dispatchNotificationEmail(d, u.user.id)).toBe(false);
  });

  it("毎日の定期処理が、送り残した分を送る", async () => {
    const author = await makeUser(d);
    const c = await makeUser(d);
    const { id } = await createPost(d, author.viewer, { body: "x", visibility: "members" });
    await addComment(d, c.viewer, { postId: id, body: "1" });
    expect(await dispatchPendingNotificationEmails(d)).toBeGreaterThanOrEqual(1);
    expect(await mailsTo(author.user.email)).toHaveLength(1);
  });
});

describe("配信停止のリンク", () => {
  it("署名が正しいときだけ、その人のその種類だけを止める", async () => {
    const u = await makeUser(d);
    const token = unsubscribeToken(u.user.id, "digest");
    expect(parseUnsubscribeToken(token)).toEqual({ userId: u.user.id, kind: "digest" });
    expect(parseUnsubscribeToken(token.replace(".digest.", ".instant."))).toBeNull();
    expect(parseUnsubscribeToken(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"))).toBeNull();
    expect(parseUnsubscribeToken("garbage")).toBeNull();
    await expect(unsubscribe(d, "garbage")).rejects.toMatchObject({ code: "invalid" });
    await unsubscribe(d, token);
    expect(await getEmailPrefs(d, u.viewer)).toEqual({ emailInstant: true, emailDigest: false });
  });
});

describe("週 1 回のまとめ", () => {
  it("日本時間の月曜日だけ", () => {
    expect(isDigestDay(new Date("2026-09-27T18:00:00Z"))).toBe(true); // 月曜 3:00 JST
    expect(isDigestDay(new Date("2026-09-27T12:00:00Z"))).toBe(false); // 日曜 21:00 JST
  });

  it("見られる投稿だけを数え、何もなければ送らない。6 日以内に 2 通は送らない", async () => {
    // 他のテストの投稿も数に入るので、未来の日時で「この 1 週間」を切り出す
    const now = new Date(Date.now() + 365 * 24 * 3600_000);
    const within = new Date(now.getTime() - 24 * 3600_000);
    const me = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, me.user.id, friend.user.id);
    await rawPost(d, friend.user.id, { visibility: "friends", createdAt: within });
    await rawPost(d, stranger.user.id, { visibility: "friends", createdAt: within }); // 見えない
    await rawPost(d, stranger.user.id, { visibility: "members", createdAt: within });
    await sendWeeklyDigests(d, now);
    const [mail] = await mailsTo(me.user.email);
    expect(mail!.subject).toBe("【Kakomi】今週のお知らせ");
    expect(mail!.body).toContain("あなたが見られる新しい投稿：2 件");
    expect(mail!.body).toMatch(/\.digest\.[0-9a-f]{32}/);

    await sendWeeklyDigests(d, new Date(now.getTime() + 2 * 24 * 3600_000));
    expect(await mailsTo(me.user.email)).toHaveLength(1);

    const quiet = await makeUser(d);
    await setEmailPrefs(d, quiet.viewer, { emailInstant: true, emailDigest: false });
    await sendWeeklyDigests(d, now);
    expect(await mailsTo(quiet.user.email)).toHaveLength(0);
  });
});

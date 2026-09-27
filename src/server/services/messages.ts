import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { conversations, messages, profiles, users } from "../db/schema";
import { AppError, invalid, notFound } from "../lib/errors";
import { assertMember } from "../lib/policy";
import { blockedBetween } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";
import { notify } from "./notifications";
import { consume } from "./ratelimit";

/**
 * 1 対 1 メッセージ（F-16）。
 *
 * - 送れるのは承認済みの会員どうし。ブロック関係（どちら向きでも）の相手とは、やりとりそのものが
 *   存在しないのと同じ（一覧にも出さず、開くと 404）
 * - 相手が停止中なら一覧から外す。退会した相手とのやりとりは「退会したメンバー」として読めるが、送れない
 * - 本文は当事者の 2 人だけに見せる。管理者にも見せない（困ったときは相手を会員として通報する）
 * - 知らせるのは、未読がない状態で届いた最初の 1 通だけ（1 通ごとに通知しない）
 */
export const MESSAGE_MAX = 2000;
export const MESSAGE_PAGE = 50;

const bodySchema = z.string().trim().min(1, "メッセージを入れてください。").max(MESSAGE_MAX, `メッセージは ${MESSAGE_MAX} 文字までです。`);
const pair = (a: string, b: string) => (a < b ? { userA: a, userB: b } : { userA: b, userB: a });
/** その会話での、viewer の既読日時の列と相手の列 */
const mySide = (viewerId: string) => sql`CASE WHEN ${conversations.userA} = ${viewerId} THEN ${conversations.readAtA} ELSE ${conversations.readAtB} END`;
const partnerCol = (viewerId: string) => sql<string>`CASE WHEN ${conversations.userA} = ${viewerId} THEN ${conversations.userB} ELSE ${conversations.userA} END`;
const involves = (viewerId: string) => or(eq(conversations.userA, viewerId), eq(conversations.userB, viewerId))!;

/** 相手として見せてよいか：本人以外で、会員か退会済みで、ブロック関係にない */
async function partnerFor(db: Db, viewer: Viewer, otherId: string) {
  if (!z.uuid().safeParse(otherId).success || otherId === viewer.id) return null;
  const [u] = await db
    .select({ id: users.id, displayName: users.displayName, status: users.status, termsAcceptedAt: users.termsAcceptedAt, avatarMediaId: profiles.avatarMediaId })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(users.id, otherId), inArray(users.status, ["active", "withdrawn"]), sql`NOT ${blockedBetween(viewer.id, otherId)}`));
  if (!u) return null;
  const withdrawn = u.status === "withdrawn";
  return {
    id: u.id,
    displayName: withdrawn ? "退会したメンバー" : u.displayName,
    avatarMediaId: withdrawn ? null : u.avatarMediaId,
    // 規約に同意する前の人には送れない（まだ中に入っていない）
    canReceive: u.status === "active" && u.termsAcceptedAt != null,
    withdrawn,
  };
}

async function findConversation(db: Db, a: string, b: string) {
  const p = pair(a, b);
  const [c] = await db.select().from(conversations).where(and(eq(conversations.userA, p.userA), eq(conversations.userB, p.userB)));
  return c ?? null;
}

export async function sendMessage(db: Db, viewer: Viewer, otherId: string, raw: string): Promise<{ id: string }> {
  assertMember(viewer);
  const partner = await partnerFor(db, viewer, otherId);
  if (!partner || !partner.canReceive) throw notFound("この相手にはメッセージを送れません。");
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]!.message);
  const [me] = await db.select({ approvedAt: users.approvedAt }).from(users).where(eq(users.id, viewer.id));
  const isNew = !me?.approvedAt || Date.now() - me.approvedAt.getTime() < 7 * 24 * 60 * 60 * 1000;
  if (!(await consume(db, `message:${viewer.id}`, isNew ? 60 : 300, 60 * 60))) {
    throw new AppError("rate_limited", "短時間にメッセージが集中しています。少し時間をおいてください。");
  }

  return db.transaction(async (tx) => {
    const p = pair(viewer.id, otherId);
    await tx.insert(conversations).values(p).onConflictDoNothing();
    const [c] = await tx.select().from(conversations).where(and(eq(conversations.userA, p.userA), eq(conversations.userB, p.userB))).for("update");
    const partnerReadAt = c!.userA === otherId ? c!.readAtA : c!.readAtB;
    // 相手にまだ読んでいない私のメッセージがあれば、通知は増やさない
    const [pending] = await tx
      .select({ one: sql`1` })
      .from(messages)
      .where(and(eq(messages.conversationId, c!.id), eq(messages.senderId, viewer.id), isNull(messages.deletedAt), partnerReadAt ? gt(messages.createdAt, partnerReadAt) : undefined))
      .limit(1);
    const now = new Date();
    const [m] = await tx.insert(messages).values({ conversationId: c!.id, senderId: viewer.id, body: parsed.data, createdAt: now }).returning({ id: messages.id });
    await tx
      .update(conversations)
      .set({ lastMessageAt: now, ...(c!.userA === viewer.id ? { readAtA: now } : { readAtB: now }) })
      .where(eq(conversations.id, c!.id));
    if (!pending) await notify(tx, { userId: otherId, type: "message", actorId: viewer.id });
    return { id: m!.id };
  });
}

export type ConversationSummary = {
  partner: { id: string; displayName: string; avatarMediaId: string | null; withdrawn: boolean };
  lastMessage: { body: string; mine: boolean; createdAt: Date } | null;
  unread: number;
};

/** やりとりの一覧（新しい順）。ブロック関係・停止中の相手とのものは出さない */
export async function listConversations(db: Db, viewer: Viewer, limit = 50): Promise<ConversationSummary[]> {
  assertMember(viewer);
  const partner = partnerCol(viewer.id);
  const rows = await db
    .select({
      id: conversations.id,
      partnerId: partner,
      readAt: sql<Date | null>`${mySide(viewer.id)}`.mapWith(conversations.readAtA),
      displayName: users.displayName,
      status: users.status,
      avatarMediaId: profiles.avatarMediaId,
    })
    .from(conversations)
    .innerJoin(users, eq(users.id, partner))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(involves(viewer.id), inArray(users.status, ["active", "withdrawn"]), sql`NOT ${blockedBetween(viewer.id, partner)}`))
    .orderBy(desc(conversations.lastMessageAt))
    .limit(limit);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [latest, unread] = await Promise.all([
    db
      .selectDistinctOn([messages.conversationId], { conversationId: messages.conversationId, body: messages.body, senderId: messages.senderId, createdAt: messages.createdAt, deletedAt: messages.deletedAt })
      .from(messages)
      .where(inArray(messages.conversationId, ids))
      .orderBy(messages.conversationId, desc(messages.createdAt)),
    db
      .select({ conversationId: messages.conversationId, n: sql<number>`count(*)::int` })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(inArray(messages.conversationId, ids), ne(messages.senderId, viewer.id), isNull(messages.deletedAt), sql`(${mySide(viewer.id)} IS NULL OR ${messages.createdAt} > ${mySide(viewer.id)})`))
      .groupBy(messages.conversationId),
  ]);
  return rows.map((r) => {
    const last = latest.find((l) => l.conversationId === r.id);
    const withdrawn = r.status === "withdrawn";
    return {
      partner: { id: r.partnerId, displayName: withdrawn ? "退会したメンバー" : r.displayName, avatarMediaId: withdrawn ? null : r.avatarMediaId, withdrawn },
      lastMessage: last ? { body: last.deletedAt ? "（削除されたメッセージ）" : last.body.slice(0, 80), mine: last.senderId === viewer.id, createdAt: last.createdAt } : null,
      unread: unread.find((u) => u.conversationId === r.id)?.n ?? 0,
    };
  });
}

export type MessageDTO = { id: string; body: string; mine: boolean; deleted: boolean; createdAt: Date };

/**
 * 相手とのやりとりを開く（開いたら既読にする）。まだやりとりがなければ空で返す。
 * 相手として見せられない（ブロック関係・停止中・会員でない）なら null。
 */
export async function openConversation(db: Db, viewer: Viewer, otherId: string, opts: { before?: Date | null } = {}) {
  assertMember(viewer);
  const partner = await partnerFor(db, viewer, otherId);
  if (!partner) return null;
  const c = await findConversation(db, viewer.id, otherId);
  let list: MessageDTO[] = [];
  let hasOlder = false;
  if (c) {
    const rows = await db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, c.id), opts.before && !Number.isNaN(opts.before.getTime()) ? lt(messages.createdAt, opts.before) : undefined))
      .orderBy(desc(messages.createdAt))
      .limit(MESSAGE_PAGE + 1);
    hasOlder = rows.length > MESSAGE_PAGE;
    list = rows
      .slice(0, MESSAGE_PAGE)
      .reverse()
      .map((m) => ({ id: m.id, body: m.deletedAt ? "" : m.body, mine: m.senderId === viewer.id, deleted: m.deletedAt != null, createdAt: m.createdAt }));
    if (!opts.before) {
      await db
        .update(conversations)
        .set(c.userA === viewer.id ? { readAtA: new Date() } : { readAtB: new Date() })
        .where(eq(conversations.id, c.id));
    }
  }
  return { partner, messages: list, olderBefore: hasOlder ? list[0]!.createdAt : null };
}

/** 自分が送ったメッセージを消す（本文もその場で消す） */
export async function deleteMessage(db: Db, viewer: Viewer, messageId: string): Promise<{ partnerId: string }> {
  assertMember(viewer);
  if (!z.uuid().safeParse(messageId).success) throw notFound();
  const [m] = await db
    .select({ id: messages.id, senderId: messages.senderId, partnerId: partnerCol(viewer.id) })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.id, messageId), involves(viewer.id)));
  if (!m || m.senderId !== viewer.id) throw notFound();
  await db.update(messages).set({ deletedAt: new Date(), body: "" }).where(eq(messages.id, m.id));
  return { partnerId: m.partnerId };
}

/** 未読のメッセージの数（ナビのバッジ用）。ブロック関係・停止中の相手からのものは数えない */
export async function unreadMessageCount(db: Db, viewer: Viewer): Promise<number> {
  const partner = partnerCol(viewer.id);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(users, eq(users.id, partner))
    .where(
      and(
        involves(viewer.id),
        ne(messages.senderId, viewer.id),
        isNull(messages.deletedAt),
        eq(users.status, "active"),
        sql`NOT ${blockedBetween(viewer.id, partner)}`,
        sql`(${mySide(viewer.id)} IS NULL OR ${messages.createdAt} > ${mySide(viewer.id)})`,
      ),
    );
  return row?.n ?? 0;
}

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { blockedBetween, visiblePost } from "../lib/visibility";
import type { Db, DbOrTx } from "../db/client";
import { notifications, users } from "../db/schema";
import { assertMember } from "../lib/policy";
import type { Viewer } from "../lib/viewer";

export type NotificationType =
  | "comment"
  | "reply"
  | "reaction"
  | "friend_request"
  | "friend_accepted"
  | "report_resolved"
  | "moderation"
  | "application_submitted"
  | "application_overdue"
  | "report_submitted"
  | "ownership_transferred";

/** 運営の通知（審査・通報）。管理者個人のブロック・ミュートでは止めない */
export const OPS_NOTIFICATION_TYPES: NotificationType[] = ["application_submitted", "application_overdue", "report_submitted", "ownership_transferred", "moderation", "report_resolved"];

export async function notify(
  db: DbOrTx,
  n: { userId: string; type: NotificationType; actorId?: string | null; postId?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  if (n.actorId && n.actorId === n.userId) return; // 自分の操作は自分に通知しない
  // ブロックし合っている相手・ミュートしている相手からの通知は作らない
  if (n.actorId && !OPS_NOTIFICATION_TYPES.includes(n.type)) {
    const [silenced] = await db
      .select({ one: sql`1` })
      .from(users)
      .where(sql`${users.id} = ${n.userId} AND (${blockedBetween(n.userId, n.actorId)} OR EXISTS (SELECT 1 FROM user_mutes um WHERE um.muter_id = ${n.userId} AND um.muted_id = ${n.actorId}))`)
      .limit(1);
    if (silenced) return;
  }
  await db.insert(notifications).values({
    userId: n.userId,
    type: n.type,
    actorId: n.actorId ?? null,
    postId: n.postId ?? null,
    data: n.data ?? {},
  });
}

/** 管理者全員に通知（新規申請・新規通報） */
export async function notifyAdmins(
  db: DbOrTx,
  n: { type: NotificationType; actorId?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, "active"), inArray(users.role, ["admin", "owner"])));
  for (const a of admins) await notify(db, { ...n, userId: a.id });
}

/**
 * 投稿にひもづく通知は、いまその投稿が見える場合だけ出す
 * （友達解除・非表示・削除の後に、見えない投稿の存在や相手の名前が通知から漏れないように）
 */
function stillVisible(viewerId: string) {
  return and(
    or(isNull(notifications.postId), sql`EXISTS (SELECT 1 FROM posts WHERE posts.id = ${notifications.postId} AND ${visiblePost(viewerId)})`),
    // 後からブロック・ミュートした相手の通知も出さない
    or(
      isNull(notifications.actorId),
      inArray(notifications.type, OPS_NOTIFICATION_TYPES),
      sql`NOT (${blockedBetween(viewerId, sql`${notifications.actorId}`)} OR EXISTS (SELECT 1 FROM user_mutes um WHERE um.muter_id = ${viewerId} AND um.muted_id = ${notifications.actorId}))`,
    ),
  )!;
}

export async function listNotifications(db: Db, viewer: Viewer, limit = 50) {
  assertMember(viewer);
  return db
    .select({
      id: notifications.id,
      type: notifications.type,
      postId: notifications.postId,
      data: notifications.data,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actorId: notifications.actorId,
      actorName: users.displayName,
      actorStatus: users.status,
    })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorId))
    .where(and(eq(notifications.userId, viewer.id), stillVisible(viewer.id)))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function unreadCount(db: Db, viewer: Viewer): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt), stillVisible(viewer.id)));
  return row?.n ?? 0;
}

export async function markAllRead(db: Db, viewer: Viewer): Promise<void> {
  assertMember(viewer);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
}

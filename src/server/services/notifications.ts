import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
  | "report_submitted";

export async function notify(
  db: DbOrTx,
  n: { userId: string; type: NotificationType; actorId?: string | null; postId?: string | null; data?: Record<string, unknown> },
): Promise<void> {
  if (n.actorId && n.actorId === n.userId) return; // 自分の操作は自分に通知しない
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
    .where(eq(notifications.userId, viewer.id))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
}

export async function unreadCount(db: Db, viewer: Viewer): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
  return row?.n ?? 0;
}

export async function markAllRead(db: Db, viewer: Viewer): Promise<void> {
  assertMember(viewer);
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, viewer.id), isNull(notifications.readAt)));
}

import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../db/client";
import { friendships, notifications, profiles, userBlocks, userMutes, users } from "../db/schema";
import { AppError, invalid, notFound } from "../lib/errors";
import { assertMember } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { OPS_NOTIFICATION_TYPES } from "./notifications";
import { consume } from "./ratelimit";

/**
 * ブロックとミュート（F-21）。
 * - ブロック：双方向。お互いの投稿・コメント・プロフィールが見えなくなり、友達関係も解除する。
 *   相手からの友達申請・コメント・リアクション・通知も届かない。ブロックされた側には伝えない（相手が見えなくなるだけ）
 * - ミュート：一方向。相手の投稿を自分のホームのフィードから外し、相手からの通知を止める。相手には伝わらない
 * どちらも個人の設定なので、監査ログには残さない。管理者の審査・通報対応には影響しない。
 */

export async function isBlockedBetween(db: DbOrTx, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(userBlocks)
    .where(or(and(eq(userBlocks.blockerId, a), eq(userBlocks.blockedId, b)), and(eq(userBlocks.blockerId, b), eq(userBlocks.blockedId, a))))
    .limit(1);
  return !!row;
}

/** 相手が viewer をブロックしているか（相手のプロフィールを 404 にするため） */
export async function isBlockedBy(db: DbOrTx, viewerId: string, otherId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(userBlocks)
    .where(and(eq(userBlocks.blockerId, otherId), eq(userBlocks.blockedId, viewerId)))
    .limit(1);
  return !!row;
}

async function target(db: Db, viewer: Viewer, otherId: string) {
  if (!z.uuid().safeParse(otherId).success) throw notFound("会員が見つかりません。");
  if (otherId === viewer.id) throw invalid("自分自身は指定できません。");
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, otherId), eq(users.status, "active")));
  // 相手がこちらをブロックしている場合も「見つからない」にする（ブロックの有無を明かさない）
  if (!u || (await isBlockedBy(db, viewer.id, otherId))) throw notFound("会員が見つかりません。");
}

async function rateLimit(db: Db, viewer: Viewer) {
  if (!(await consume(db, `block:${viewer.id}`, 60, 60 * 60))) {
    throw new AppError("rate_limited", "短時間の操作が多すぎます。少し時間をおいてください。");
  }
}

export async function blockUser(db: Db, viewer: Viewer, otherId: string) {
  assertMember(viewer);
  await target(db, viewer, otherId);
  await rateLimit(db, viewer);
  await db.transaction(async (tx) => {
    await tx.insert(userBlocks).values({ blockerId: viewer.id, blockedId: otherId }).onConflictDoNothing();
    // 友達関係・申請はどちら向きでも解除する（ブロックを外しても自動では戻らない）
    await tx
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.requesterId, viewer.id), eq(friendships.addresseeId, otherId)),
          and(eq(friendships.requesterId, otherId), eq(friendships.addresseeId, viewer.id)),
        ),
      );
    // お互いに届いていた通知は消す（相手の名前を目にしないように）。運営の通知（審査・通報）は残す
    await tx
      .delete(notifications)
      .where(
        and(
          or(and(eq(notifications.userId, viewer.id), eq(notifications.actorId, otherId)), and(eq(notifications.userId, otherId), eq(notifications.actorId, viewer.id))),
          notInArray(notifications.type, OPS_NOTIFICATION_TYPES),
        ),
      );
  });
}

export async function unblockUser(db: Db, viewer: Viewer, otherId: string) {
  assertMember(viewer);
  if (!z.uuid().safeParse(otherId).success) throw notFound();
  await db.delete(userBlocks).where(and(eq(userBlocks.blockerId, viewer.id), eq(userBlocks.blockedId, otherId)));
}

export async function muteUser(db: Db, viewer: Viewer, otherId: string) {
  assertMember(viewer);
  await target(db, viewer, otherId);
  await rateLimit(db, viewer);
  await db.insert(userMutes).values({ muterId: viewer.id, mutedId: otherId }).onConflictDoNothing();
}

export async function unmuteUser(db: Db, viewer: Viewer, otherId: string) {
  assertMember(viewer);
  if (!z.uuid().safeParse(otherId).success) throw notFound();
  await db.delete(userMutes).where(and(eq(userMutes.muterId, viewer.id), eq(userMutes.mutedId, otherId)));
}

/** 自分がブロック・ミュートしている人（設定画面で解除するため） */
export async function listBlocksAndMutes(db: Db, viewer: Viewer) {
  assertMember(viewer);
  const [blocked, muted] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName, avatarMediaId: profiles.avatarMediaId, since: userBlocks.createdAt })
      .from(userBlocks)
      .innerJoin(users, eq(users.id, userBlocks.blockedId))
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(userBlocks.blockerId, viewer.id))
      .orderBy(desc(userBlocks.createdAt)),
    db
      .select({ id: users.id, displayName: users.displayName, avatarMediaId: profiles.avatarMediaId, since: userMutes.createdAt })
      .from(userMutes)
      .innerJoin(users, eq(users.id, userMutes.mutedId))
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(userMutes.muterId, viewer.id))
      .orderBy(desc(userMutes.createdAt)),
  ]);
  return { blocked, muted };
}

/** viewer から見た相手との関係（プロフィールのボタン表示用） */
export async function blockState(db: Db, viewer: Viewer, otherId: string): Promise<{ blocking: boolean; muting: boolean }> {
  const [[b], [m]] = await Promise.all([
    db.select({ one: sql`1` }).from(userBlocks).where(and(eq(userBlocks.blockerId, viewer.id), eq(userBlocks.blockedId, otherId))).limit(1),
    db.select({ one: sql`1` }).from(userMutes).where(and(eq(userMutes.muterId, viewer.id), eq(userMutes.mutedId, otherId))).limit(1),
  ]);
  return { blocking: !!b, muting: !!m };
}

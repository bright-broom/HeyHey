import { and, asc, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { applications, comments, eventRsvps, events, friendships, groupMembers, invitations, media, messages, posts, profiles, sessions, users } from "../db/schema";
import { forbidden, invalid } from "../lib/errors";
import { verifyPassword } from "../lib/password";
import { assertMember } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { processImage, removeStoredFile } from "./media";
import { blockedBetween } from "../lib/visibility";
import { blockState, isBlockedBy } from "./blocks";
import { relationship } from "./friends";
import { ownedGroups } from "./groups";

/** 会員のプロフィール。承認済み会員（と本人）のものだけ返す */
export async function getProfile(db: Db, viewer: Viewer, userId: string) {
  assertMember(viewer);
  if (!z.uuid().safeParse(userId).success) return null;
  const [row] = await db
    .select({
      id: users.id,
      displayName: users.displayName,
      status: users.status,
      role: users.role,
      approvedAt: users.approvedAt,
      bio: profiles.bio,
      affiliation: profiles.affiliation,
      avatarMediaId: profiles.avatarMediaId,
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.id, userId));
  if (!row || (row.status !== "active" && row.id !== viewer.id)) return null;
  // 相手にブロックされていれば、存在しないのと同じに見せる
  if (row.id !== viewer.id && (await isBlockedBy(db, viewer.id, row.id))) return null;
  // こちらがブロックしている相手は、解除のために名前だけ見せる（自己紹介・写真・友達数は出さない）
  const state = row.id === viewer.id ? { blocking: false, muting: false } : await blockState(db, viewer, userId);
  if (state.blocking) {
    return { ...row, bio: "", affiliation: "", avatarMediaId: null, friendCount: 0, relationship: "none" as const, ...state };
  }
  const [{ n: friendCount } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(friendships)
    .where(and(eq(friendships.status, "accepted"), or(eq(friendships.requesterId, userId), eq(friendships.addresseeId, userId))));
  return {
    ...row,
    bio: row.bio ?? "",
    affiliation: row.affiliation ?? "",
    friendCount,
    relationship: await relationship(db, viewer, userId),
    ...state,
  };
}

const profileSchema = z.object({
  displayName: z.string().trim().min(1, "表示名を入力してください。").max(40, "表示名は 40 文字以内です。"),
  affiliation: z.string().trim().max(120, "所属は 120 文字以内です。"),
  bio: z.string().trim().max(1000, "自己紹介は 1000 文字以内です。"),
});

export async function updateProfile(
  db: Db,
  viewer: Viewer,
  input: { displayName: string; affiliation: string; bio: string; avatar?: Buffer | null; removeAvatar?: boolean },
) {
  assertMember(viewer);
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const avatar = input.avatar?.byteLength ? await processImage(input.avatar, { square: 400 }) : null;
  const [current] = await db.select().from(profiles).where(eq(profiles.userId, viewer.id));
  const oldAvatarId = current?.avatarMediaId ?? null;

  try {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ displayName: parsed.data.displayName, updatedAt: new Date() }).where(eq(users.id, viewer.id));
      let avatarMediaId = oldAvatarId;
      if (avatar) {
        const [m] = await tx
          .insert(media)
          .values({ ownerId: viewer.id, kind: "avatar", storageKey: avatar.key, mime: avatar.mime, width: avatar.width, height: avatar.height, bytes: avatar.bytes })
          .returning({ id: media.id });
        avatarMediaId = m!.id;
      } else if (input.removeAvatar) {
        avatarMediaId = null;
      }
      await tx
        .insert(profiles)
        .values({ userId: viewer.id, affiliation: parsed.data.affiliation, bio: parsed.data.bio, avatarMediaId })
        .onConflictDoUpdate({
          target: profiles.userId,
          set: { affiliation: parsed.data.affiliation, bio: parsed.data.bio, avatarMediaId, updatedAt: new Date() },
        });
    });
  } catch (e) {
    if (avatar) await removeStoredFile(avatar.key);
    throw e;
  }
  // 差し替え前のアバターは削除（ファイルと行）
  if (oldAvatarId && (avatar || input.removeAvatar)) {
    const [old] = await db.delete(media).where(eq(media.id, oldAvatarId)).returning({ key: media.storageKey });
    if (old) await removeStoredFile(old.key);
  }
}

/** 会員ディレクトリ・検索（氏名・所属） */
export async function searchMembers(db: Db, viewer: Viewer, qRaw = "") {
  assertMember(viewer);
  const q = qRaw.trim().slice(0, 50);
  // ブロックし合っている人は名簿にも出さない（ブロックした人は設定画面から解除できる）
  const conds = [eq(users.status, "active"), sql`NOT ${blockedBetween(viewer.id, sql`${users.id}`)}`];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(users.displayName, like), ilike(profiles.affiliation, like))!);
  }
  return db
    .select({ id: users.id, displayName: users.displayName, affiliation: profiles.affiliation, avatarMediaId: profiles.avatarMediaId })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(...conds))
    .orderBy(asc(users.displayName))
    .limit(100);
}

/**
 * 退会。投稿を「削除」するか「匿名化して残す」かを本人が選ぶ。
 * メールアドレスは退会時点で解放し、個人を特定できる情報を消す。
 */
export async function withdraw(db: Db, viewer: Viewer, input: { password: string; mode: "delete" | "anonymize" }) {
  assertMember(viewer);
  // 最後の管理者は退会できない（管理者が 1 人もいなくなるため）
  if (viewer.role === "admin" || viewer.role === "owner") {
    const [other] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, "active"), sql`${users.role} IN ('admin', 'owner')`, sql`${users.id} <> ${viewer.id}`))
      .limit(1);
    if (!other) throw forbidden("最後の管理者は退会できません。先にほかの会員を管理者に任命してください。");
  }
  if (input.mode !== "delete" && input.mode !== "anonymize") throw invalid("投稿の扱いを選んでください。");
  const [me] = await db.select().from(users).where(eq(users.id, viewer.id));
  if (!me || !(await verifyPassword(input.password, me.passwordHash))) throw invalid("パスワードが正しくありません。");

  const filesToRemove: string[] = [];
  await db.transaction(async (tx) => {
    // グループの代表なら、先に移してもらう（閉じたグループも。確認はこのトランザクションの中で）
    const owned = await ownedGroups(tx, viewer.id);
    if (owned.length) throw invalid(`グループ「${owned.join("」「")}」の代表です。先にほかのメンバーへ代表を移してください（閉じたグループは、再開してから移せます）。`);
    const now = new Date();
    if (input.mode === "delete") {
      await tx.update(posts).set({ deletedAt: now }).where(eq(posts.authorId, viewer.id));
      await tx.update(comments).set({ deletedAt: now }).where(eq(comments.authorId, viewer.id));
      // メッセージは本文ごと消す（相手の画面には「削除されたメッセージ」と出る）
      await tx.update(messages).set({ deletedAt: now, body: "" }).where(eq(messages.senderId, viewer.id));
      await tx.update(events).set({ deletedAt: now }).where(eq(events.creatorId, viewer.id));
      const postImages = await tx
        .delete(media)
        .where(and(eq(media.ownerId, viewer.id), eq(media.kind, "post")))
        .returning({ key: media.storageKey });
      filesToRemove.push(...postImages.map((m) => m.key));
    }
    const avatars = await tx.delete(media).where(and(eq(media.ownerId, viewer.id), eq(media.kind, "avatar"))).returning({ key: media.storageKey });
    filesToRemove.push(...avatars.map((a) => a.key));
    await tx.update(profiles).set({ bio: "", affiliation: "", avatarMediaId: null }).where(eq(profiles.userId, viewer.id));
    await tx.delete(friendships).where(or(eq(friendships.requesterId, viewer.id), eq(friendships.addresseeId, viewer.id)));
    await tx.delete(groupMembers).where(eq(groupMembers.userId, viewer.id));
    await tx.delete(eventRsvps).where(eq(eventRsvps.userId, viewer.id));
    await tx.update(invitations).set({ revokedAt: now, revokedById: viewer.id }).where(and(eq(invitations.createdById, viewer.id), sql`${invitations.revokedAt} IS NULL`));
    await tx
      .update(applications)
      .set({ fullName: "（退会）", affiliation: "", relationship: "", introduction: "" })
      .where(eq(applications.userId, viewer.id));
    await tx
      .update(users)
      .set({
        status: "withdrawn",
        withdrawnAt: now,
        email: `withdrawn+${viewer.id}@invalid.local`,
        displayName: "退会したメンバー",
        passwordHash: "!",
        updatedAt: now,
      })
      .where(eq(users.id, viewer.id));
    await tx.delete(sessions).where(eq(sessions.userId, viewer.id));
    await audit(tx, { actorId: viewer.id, action: "user.withdraw", targetType: "user", targetId: viewer.id, meta: { mode: input.mode } });
  });
  await Promise.all(filesToRemove.map(removeStoredFile));
}

/** 申請者本人向け：自分の申請内容と状態 */
export async function myApplication(db: Db, userId: string) {
  const [row] = await db
    .select()
    .from(applications)
    .where(eq(applications.userId, userId))
    .orderBy(sql`${applications.createdAt} desc`)
    .limit(1);
  return row ?? null;
}

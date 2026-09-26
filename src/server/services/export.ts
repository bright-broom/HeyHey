import { and, asc, eq, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import { applications, comments, friendships, invitations, media, posts, profiles, reactions, reports, userMfa, users } from "../db/schema";
import { AppError } from "../lib/errors";
import { assertMember } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { consume } from "./ratelimit";

/**
 * 本人のデータの書き出し（個人情報の開示請求への対応）。本人が作った・本人に関するデータだけを出す。
 * - パスワードのハッシュ、セッション、トークン、2 段階認証の鍵、リカバリーコードは出さない
 * - 他人が本人を通報した記録は出さない（通報者の保護）
 * - 画像は中身ではなく一覧と取得用の URL（ログイン中の本人なら開ける）
 * 書き出したことは監査ログに残す（非機能要件「データ出力」）。
 */
export async function exportMyData(db: Db, viewer: Viewer) {
  assertMember(viewer);
  if (!(await consume(db, `export:${viewer.id}`, 5, 24 * 60 * 60))) {
    throw new AppError("rate_limited", "データの書き出しは 1 日 5 回までです。");
  }
  const id = viewer.id;
  const other = alias(users, "other");
  const [account] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      createdAt: users.createdAt,
      emailVerifiedAt: users.emailVerifiedAt,
      approvedAt: users.approvedAt,
      termsAcceptedAt: users.termsAcceptedAt,
      lastSeenAt: users.lastSeenAt,
      invitedBy: other.displayName,
    })
    .from(users)
    .leftJoin(other, eq(other.id, users.invitedById))
    .where(eq(users.id, id));
  const [profile] = await db.select({ bio: profiles.bio, affiliation: profiles.affiliation }).from(profiles).where(eq(profiles.userId, id));
  const [mfa] = await db.select({ enabledAt: userMfa.enabledAt }).from(userMfa).where(eq(userMfa.userId, id));

  const [application, myPosts, myComments, myReactions, friends, myInvitations, myMedia, myReports] = await Promise.all([
    db
      .select({
        fullName: applications.fullName,
        affiliation: applications.affiliation,
        relationship: applications.relationship,
        introduction: applications.introduction,
        status: applications.status,
        createdAt: applications.createdAt,
        decidedAt: applications.decidedAt,
      })
      .from(applications)
      .where(eq(applications.userId, id))
      .orderBy(asc(applications.createdAt)),
    db
      .select({ id: posts.id, body: posts.body, visibility: posts.visibility, createdAt: posts.createdAt, editedAt: posts.editedAt, hiddenAt: posts.hiddenAt })
      .from(posts)
      .where(and(eq(posts.authorId, id), isNull(posts.deletedAt)))
      .orderBy(asc(posts.createdAt)),
    db
      .select({ id: comments.id, postId: comments.postId, parentId: comments.parentId, body: comments.body, createdAt: comments.createdAt, hiddenAt: comments.hiddenAt })
      .from(comments)
      .where(and(eq(comments.authorId, id), isNull(comments.deletedAt)))
      .orderBy(asc(comments.createdAt)),
    db
      .select({ type: reactions.type, postId: reactions.postId, commentId: reactions.commentId, createdAt: reactions.createdAt })
      .from(reactions)
      .where(eq(reactions.userId, id))
      .orderBy(asc(reactions.createdAt)),
    db
      .select({ requesterId: friendships.requesterId, addresseeId: friendships.addresseeId, status: friendships.status, createdAt: friendships.createdAt, respondedAt: friendships.respondedAt, otherName: other.displayName })
      .from(friendships)
      .innerJoin(other, or(and(eq(friendships.requesterId, id), eq(other.id, friendships.addresseeId)), and(eq(friendships.addresseeId, id), eq(other.id, friendships.requesterId))))
      .where(or(eq(friendships.requesterId, id), eq(friendships.addresseeId, id))),
    db
      .select({ note: invitations.note, maxUses: invitations.maxUses, useCount: invitations.useCount, createdAt: invitations.createdAt, expiresAt: invitations.expiresAt, revokedAt: invitations.revokedAt })
      .from(invitations)
      .where(eq(invitations.createdById, id))
      .orderBy(asc(invitations.createdAt)),
    db
      .select({ id: media.id, kind: media.kind, postId: media.postId, mime: media.mime, width: media.width, height: media.height, createdAt: media.createdAt })
      .from(media)
      .where(eq(media.ownerId, id)),
    db
      .select({ targetType: reports.targetType, targetId: reports.targetId, reason: reports.reason, detail: reports.detail, status: reports.status, createdAt: reports.createdAt })
      .from(reports)
      .where(eq(reports.reporterId, id)),
  ]);

  await audit(db, { actorId: id, action: "user.export", targetType: "user", targetId: id });
  return {
    format: "kakomi-export/1",
    exportedAt: new Date().toISOString(),
    account: { ...account, twoFactorEnabledAt: mfa?.enabledAt ?? null },
    profile: profile ?? null,
    applications: application,
    posts: myPosts,
    comments: myComments,
    reactions: myReactions,
    friends: friends.map((f) => ({
      userId: f.requesterId === id ? f.addresseeId : f.requesterId,
      name: f.otherName,
      status: f.status,
      direction: f.requesterId === id ? "sent" : "received",
      createdAt: f.createdAt,
      respondedAt: f.respondedAt,
    })),
    invitations: myInvitations,
    media: myMedia.map((m) => ({ ...m, url: `/api/media/${m.id}` })),
    reportsFiled: myReports,
  };
}

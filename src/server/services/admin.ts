import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Db } from "../db/client";
import {
  applications,
  auditLogs,
  comments,
  invitations,
  mfaRecoveryCodes,
  posts,
  reports,
  userMfa,
  users,
} from "../db/schema";
import { AppError, conflict, forbidden, invalid, notFound } from "../lib/errors";
import { verifyPassword } from "../lib/password";
import { assertAdmin, assertOwner } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { deleteUserSessions } from "./auth";
import { checkSecondFactor, mfaEnabled } from "./mfa";
import { notify } from "./notifications";
import { consume } from "./ratelimit";
import { appUrl, sendMail } from "./mailer";

// ───────── 入会審査 ─────────

export const REJECT_REASONS = {
  unknown_relation: "招待者との関係が確認できなかったため",
  incomplete: "申請内容が不十分だったため",
  policy: "コミュニティの参加条件に合わないため",
  other: "その他",
} as const;
export type RejectReasonKey = keyof typeof REJECT_REASONS;

export async function listApplications(db: Db, viewer: Viewer, filter: "open" | "decided" = "open") {
  assertAdmin(viewer);
  const inviter = alias(users, "inviter");
  const where =
    filter === "open"
      ? and(inArray(applications.status, ["pending", "on_hold"]), eq(users.status, "pending"))
      : inArray(applications.status, ["approved", "rejected"]);
  return db
    .select({
      id: applications.id,
      status: applications.status,
      fullName: applications.fullName,
      affiliation: applications.affiliation,
      relationship: applications.relationship,
      introduction: applications.introduction,
      decisionReason: applications.decisionReason,
      decidedAt: applications.decidedAt,
      createdAt: applications.createdAt,
      userId: users.id,
      email: users.email,
      displayName: users.displayName,
      emailVerifiedAt: users.emailVerifiedAt,
      inviterId: inviter.id,
      inviterName: inviter.displayName,
      inviterStatus: inviter.status,
    })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .leftJoin(inviter, eq(inviter.id, users.invitedById))
    .where(where)
    .orderBy(filter === "open" ? asc(applications.createdAt) : desc(applications.decidedAt))
    .limit(200);
}

type Decision =
  | { kind: "approve" }
  | { kind: "reject"; reasonKey: RejectReasonKey; note?: string }
  | { kind: "hold"; note?: string };

/**
 * 承認／却下／保留。申請中（pending）の会員に対してだけ有効で、
 * 状態の条件付き UPDATE にすることで二重承認・競合を防ぐ。
 */
export async function decideApplication(db: Db, viewer: Viewer, applicationId: string, d: Decision) {
  assertAdmin(viewer);
  if (!z.uuid().safeParse(applicationId).success) throw notFound("申請が見つかりません。");
  if (d.kind === "reject" && !(d.reasonKey in REJECT_REASONS)) throw invalid("却下理由を選んでください。");
  const note = (("note" in d && d.note) || "").trim().slice(0, 500);

  const mail = await db.transaction(async (tx) => {
    const [app] = await tx
      .select({ a: applications, u: users })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.userId))
      .where(eq(applications.id, applicationId))
      .for("update");
    if (!app) throw notFound("申請が見つかりません。");
    if (app.u.status !== "pending" || !["pending", "on_hold"].includes(app.a.status)) {
      throw conflict("この申請はすでに処理済みか、メール確認が完了していません。");
    }
    const now = new Date();

    if (d.kind === "hold") {
      await tx.update(applications).set({ status: "on_hold", reviewerId: viewer.id, decisionReason: note || null }).where(eq(applications.id, applicationId));
      await audit(tx, { actorId: viewer.id, action: "application.hold", targetType: "user", targetId: app.u.id, reason: note || null });
      return null;
    }

    if (d.kind === "approve") {
      await tx.update(applications).set({ status: "approved", reviewerId: viewer.id, decidedAt: now }).where(eq(applications.id, applicationId));
      await tx.update(users).set({ status: "active", approvedAt: now, updatedAt: now }).where(eq(users.id, app.u.id));
      await audit(tx, { actorId: viewer.id, action: "application.approve", targetType: "user", targetId: app.u.id });
      return {
        to: app.u.email,
        subject: "【Kakomi】入会申請が承認されました",
        body: [
          `${app.u.displayName} さん`,
          "",
          "入会申請が承認されました。下のリンクからログインしてください。",
          "初回ログイン時に利用規約への同意をお願いします。",
          "",
          appUrl("/login"),
        ].join("\n"),
      };
    }

    const reason = `${REJECT_REASONS[d.reasonKey]}${note ? `（${note}）` : ""}`;
    await tx.update(applications).set({ status: "rejected", reviewerId: viewer.id, decidedAt: now, decisionReason: reason }).where(eq(applications.id, applicationId));
    await tx.update(users).set({ status: "rejected", rejectedAt: now, updatedAt: now }).where(eq(users.id, app.u.id));
    await deleteUserSessions(tx, app.u.id);
    await audit(tx, { actorId: viewer.id, action: "application.reject", targetType: "user", targetId: app.u.id, reason });
    return {
      to: app.u.email,
      subject: "【Kakomi】入会申請の結果について",
      body: [
        `${app.u.displayName} さん`,
        "",
        "申し訳ありませんが、今回の入会申請は承認されませんでした。",
        `理由：${reason}`,
        "",
        "30 日経過後、あらためて招待を受けて申請することができます。",
      ].join("\n"),
    };
  });
  if (mail) await sendMail(db, mail);
}

// ───────── 会員管理 ─────────

const statusFilter = z.enum(["all", "active", "pending", "suspended", "rejected", "withdrawn", "unverified"]);

export async function listUsers(db: Db, viewer: Viewer, opts: { q?: string; status?: string }) {
  assertAdmin(viewer);
  const status = statusFilter.catch("all").parse(opts.status ?? "all");
  const conds: SQL[] = [];
  if (status !== "all") conds.push(eq(users.status, status));
  const q = (opts.q ?? "").trim().slice(0, 50);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(users.displayName, like), ilike(users.email, like))!);
  }
  const inviter = alias(users, "inviter");
  return db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      status: users.status,
      role: users.role,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      suspendedReason: users.suspendedReason,
      inviteQuotaOverride: users.inviteQuotaOverride,
      inviterId: inviter.id,
      inviterName: inviter.displayName,
    })
    .from(users)
    .leftJoin(inviter, eq(inviter.id, users.invitedById))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(users.createdAt))
    .limit(300);
}

/** 招待の系譜：その人を招待した人の連なりと、その人が招待した人 */
export async function inviteLineage(db: Db, viewer: Viewer, userId: string) {
  assertAdmin(viewer);
  if (!z.uuid().safeParse(userId).success) return { chain: [], invitees: [] };
  const chain: { id: string; displayName: string; status: string }[] = [];
  let cursor: string | null = userId;
  for (let i = 0; i < 20 && cursor; i++) {
    const [u]: { id: string; displayName: string; status: string; invitedById: string | null }[] = await db
      .select({ id: users.id, displayName: users.displayName, status: users.status, invitedById: users.invitedById })
      .from(users)
      .where(eq(users.id, cursor));
    if (!u) break;
    chain.push({ id: u.id, displayName: u.displayName, status: u.status });
    cursor = u.invitedById;
  }
  const invitees = await db
    .select({ id: users.id, displayName: users.displayName, status: users.status })
    .from(users)
    .where(eq(users.invitedById, userId))
    .orderBy(desc(users.createdAt));
  return { chain, invitees };
}

/** 管理画面の会員詳細（メールアドレスなど管理者だけが見てよい項目を含む） */
export async function getUserForAdmin(db: Db, viewer: Viewer, userId: string) {
  assertAdmin(viewer);
  if (!z.uuid().safeParse(userId).success) return null;
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) return null;
  const { passwordHash: _omit, ...safe } = u;
  return safe;
}

async function loadTarget(db: Db, userId: string) {
  if (!z.uuid().safeParse(userId).success) throw notFound("会員が見つかりません。");
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw notFound("会員が見つかりません。");
  return u;
}

/** 管理者はオーナーを、自分自身を処分できない。オーナーは管理者を処分できる */
export function assertCanModerate(viewer: Viewer, target: { id: string; role: string }) {
  if (target.id === viewer.id) throw forbidden("自分自身は対象にできません。");
  if (target.role === "owner") throw forbidden("オーナーは対象にできません。");
  if (target.role === "admin" && viewer.role !== "owner") throw forbidden("管理者を処分できるのはオーナーのみです。");
}

export async function suspendUser(db: Db, viewer: Viewer, userId: string, reasonRaw: string) {
  assertAdmin(viewer);
  const reason = reasonRaw.trim();
  if (!reason) throw invalid("停止理由は必須です。");
  const target = await loadTarget(db, userId);
  assertCanModerate(viewer, target);
  if (target.status !== "active") throw conflict("会員（承認済み）の状態でのみ停止できます。");
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ status: "suspended", suspendedAt: new Date(), suspendedReason: reason.slice(0, 500), updatedAt: new Date() })
      .where(eq(users.id, userId));
    await deleteUserSessions(tx, userId);
    await audit(tx, { actorId: viewer.id, action: "user.suspend", targetType: "user", targetId: userId, reason });
  });
}

export async function reinstateUser(db: Db, viewer: Viewer, userId: string) {
  assertAdmin(viewer);
  const target = await loadTarget(db, userId);
  assertCanModerate(viewer, target);
  if (target.status !== "suspended") throw conflict("停止中の会員のみ復帰できます。");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ status: "active", suspendedAt: null, suspendedReason: null, updatedAt: new Date() }).where(eq(users.id, userId));
    await audit(tx, { actorId: viewer.id, action: "user.reinstate", targetType: "user", targetId: userId });
  });
}

export async function setRole(db: Db, viewer: Viewer, userId: string, role: "member" | "admin") {
  assertOwner(viewer);
  if (role !== "member" && role !== "admin") throw invalid("権限の指定が正しくありません。");
  const target = await loadTarget(db, userId);
  if (target.id === viewer.id || target.role === "owner") throw forbidden("オーナーの権限は変更できません。");
  if (target.status !== "active") throw conflict("承認済みの会員のみ権限を変更できます。");
  const promoted = role === "admin" && target.role !== "admin";
  await db.transaction(async (tx) => {
    await tx.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
    if (promoted) {
      // 会員のうちに設定された 2 段階認証は、パスワードだけで設定できたもの（誰が設定したか保証がない）。
      // 任命時に破棄して全端末からログアウトさせ、運営者の設定チケットで設定し直してもらう。
      // それまでは管理権限が働かない（policy.isAdmin）
      await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
      await tx.delete(userMfa).where(eq(userMfa.userId, userId));
      await deleteUserSessions(tx, userId);
    }
    await audit(tx, { actorId: viewer.id, action: "user.set_role", targetType: "user", targetId: userId, meta: { from: target.role, to: role } });
  });
}

/**
 * オーナー権限の移譲。相手は承認済みで 2 段階認証を設定済みの管理者に限り、
 * 移す側はパスワードと認証アプリのコードで本人確認する（最も強い権限なので、セッションだけでは動かさない）。
 * 移した後、元のオーナーは管理者になる。オーナーが 2 人にならないよう、
 * 「自分がまだオーナーであること」を条件に先に降格してから、相手を昇格する。
 */
export async function transferOwnership(db: Db, viewer: Viewer, userId: string, input: { password: string; code: string }) {
  assertOwner(viewer);
  const target = await loadTarget(db, userId);
  if (target.id === viewer.id) throw invalid("自分自身には移せません。");
  if (target.role !== "admin" || target.status !== "active" || !target.termsAcceptedAt) {
    throw conflict("オーナー権限を移せるのは、承認済みの管理者だけです。先に管理者に任命してください。");
  }
  if (!(await mfaEnabled(db, target.id))) throw conflict("移す相手が 2 段階認証を設定していません。先に設定してもらってください。");
  if (!(await consume(db, `owner:transfer:${viewer.id}`, 5, 15 * 60))) {
    throw new AppError("rate_limited", "試行回数が上限に達しました。15 分ほど待ってから再度お試しください。");
  }
  const [me] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, viewer.id));
  if (!me || !(await verifyPassword(input.password, me.passwordHash))) throw invalid("パスワードが正しくありません。");
  await db.transaction(async (tx) => {
    if ((await checkSecondFactor(tx, viewer.id, input.code)) !== "totp") throw invalid("確認コードが正しくありません。");
    // 確認の後に相手の 2 段階認証が解除されていた場合も通さない
    if (!(await mfaEnabled(tx, target.id))) throw conflict("移す相手が 2 段階認証を設定していません。");
    const [demoted] = await tx
      .update(users)
      .set({ role: "admin", updatedAt: new Date() })
      .where(and(eq(users.id, viewer.id), eq(users.role, "owner")))
      .returning({ id: users.id });
    if (!demoted) throw conflict("すでにオーナーではありません。");
    const [promoted] = await tx
      .update(users)
      .set({ role: "owner", updatedAt: new Date() })
      .where(and(eq(users.id, target.id), eq(users.role, "admin"), eq(users.status, "active")))
      .returning({ id: users.id });
    if (!promoted) throw conflict("相手の状態が変わったため、移せませんでした。");
    await audit(tx, { actorId: viewer.id, action: "user.transfer_ownership", targetType: "user", targetId: target.id, meta: { from: viewer.id, to: target.id } });
    await notify(tx, { userId: target.id, type: "ownership_transferred", actorId: viewer.id, data: { name: viewer.displayName } });
  });
}

export async function setInviteQuota(db: Db, viewer: Viewer, userId: string, quota: number | null) {
  assertAdmin(viewer);
  if (quota !== null && (!Number.isInteger(quota) || quota < 0 || quota > 100)) throw invalid("招待枠は 0〜100 の整数で指定してください。");
  const target = await loadTarget(db, userId);
  if (target.role !== "member") throw invalid("招待枠は一般会員にだけ設定できます（管理者以上は無制限）。");
  await db.transaction(async (tx) => {
    await tx.update(users).set({ inviteQuotaOverride: quota, updatedAt: new Date() }).where(eq(users.id, userId));
    await audit(tx, { actorId: viewer.id, action: "user.set_invite_quota", targetType: "user", targetId: userId, meta: { quota } });
  });
}

// ───────── 監査ログ・ダッシュボード ─────────

export async function listAuditLogs(db: Db, viewer: Viewer, limit = 200) {
  assertAdmin(viewer);
  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      targetType: auditLogs.targetType,
      targetId: auditLogs.targetId,
      reason: auditLogs.reason,
      meta: auditLogs.meta,
      createdAt: auditLogs.createdAt,
      actorName: users.displayName,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .orderBy(desc(auditLogs.id))
    .limit(Math.min(limit, 1000));
}

export async function dashboard(db: Db, viewer: Viewer) {
  assertAdmin(viewer);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const n = sql<number>`count(*)::int`;

  const [pending, activeMembers, weeklyActive, postsWeek, commentsWeek, openReports, reviewAvg, oldestPending] = await Promise.all([
    count(db.select({ n }).from(users).where(eq(users.status, "pending"))),
    count(db.select({ n }).from(users).where(eq(users.status, "active"))),
    count(db.select({ n }).from(users).where(and(eq(users.status, "active"), gt(users.lastSeenAt, weekAgo)))),
    count(db.select({ n }).from(posts).where(and(gt(posts.createdAt, weekAgo), isNull(posts.deletedAt)))),
    count(db.select({ n }).from(comments).where(and(gt(comments.createdAt, weekAgo), isNull(comments.deletedAt)))),
    count(db.select({ n }).from(reports).where(eq(reports.status, "open"))),
    db
      .select({ hours: sql<number | null>`avg(extract(epoch from (${applications.decidedAt} - ${applications.createdAt})) / 3600)::float` })
      .from(applications)
      .where(and(inArray(applications.status, ["approved", "rejected"]), gt(applications.decidedAt, monthAgo))),
    db
      .select({ createdAt: applications.createdAt })
      .from(applications)
      .innerJoin(users, eq(users.id, applications.userId))
      .where(and(eq(users.status, "pending"), inArray(applications.status, ["pending", "on_hold"])))
      .orderBy(asc(applications.createdAt))
      .limit(1),
  ]);
  const [inv] = await db
    .select({ n })
    .from(invitations)
    .where(gt(invitations.createdAt, weekAgo));
  return {
    pendingApplications: pending,
    oldestPendingAt: oldestPending[0]?.createdAt ?? null,
    avgReviewHours: reviewAvg[0]?.hours ?? null,
    activeMembers,
    weeklyActiveMembers: weeklyActive,
    postsThisWeek: postsWeek,
    commentsThisWeek: commentsWeek,
    openReports,
    invitesThisWeek: inv?.n ?? 0,
  };
}

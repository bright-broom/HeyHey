import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../db/client";
import { groupBans, groupMembers, groups, profiles, users } from "../db/schema";
import { AppError, conflict, forbidden, invalid, notFound } from "../lib/errors";
import { assertMember, isAdmin } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { blockedBetween } from "../lib/visibility";
import { audit } from "./audit";
import { notify } from "./notifications";
import { consume } from "./ratelimit";

/**
 * グループ（F-15）。
 * - 名前と説明は全会員に見せる。投稿・メンバー一覧はそのグループのアクティブなメンバーにだけ見せる
 *   （投稿の判定は lib/visibility の visiblePost。ここでは参加・管理の操作を扱う）
 * - open は誰でもすぐ参加、approval はオーナー・モデレーターの承認が必要
 * - オーナーは 1 人。モデレーターの任命・オーナーの移譲・グループを閉じるのはオーナーだけ
 *   （サイトの管理者も、運営上の必要があれば閉じられる。監査ログに残す）
 */

export type GroupRole = "owner" | "moderator" | "member";
export type Membership = { role: GroupRole; status: "active" | "pending" } | null;

const groupSchema = z.object({
  name: z.string().trim().min(1, "グループ名を入力してください。").max(40, "グループ名は 40 文字以内です。"),
  description: z.string().trim().max(500, "説明は 500 文字以内です。"),
  joinPolicy: z.enum(["open", "approval"], { message: "参加のしかたを選んでください。" }),
});

const isManager = (m: Membership) => !!m && m.status === "active" && (m.role === "owner" || m.role === "moderator");

async function membership(db: DbOrTx, groupId: string, userId: string): Promise<Membership> {
  const [m] = await db
    .select({ role: groupMembers.role, status: groupMembers.status })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
  return m ?? null;
}

/** 存在して閉じられていないグループ（閉じたグループはメンバーにだけ見せる） */
async function loadGroup(db: DbOrTx, viewer: Viewer, groupId: string) {
  if (!z.uuid().safeParse(groupId).success) throw notFound("グループが見つかりません。");
  const [g] = await db.select().from(groups).where(eq(groups.id, groupId));
  if (!g) throw notFound("グループが見つかりません。");
  const me = await membership(db, g.id, viewer.id);
  if (g.archivedAt && me?.status !== "active" && !isAdmin(viewer)) throw notFound("グループが見つかりません。");
  return { g, me };
}

async function managerIds(db: DbOrTx, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ id: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.status, "active"), sql`${groupMembers.role} IN ('owner', 'moderator')`, eq(users.status, "active")));
  return rows.map((r) => r.id);
}

// ───────── 作成・一覧・詳細 ─────────

export async function createGroup(db: Db, viewer: Viewer, raw: z.input<typeof groupSchema>): Promise<{ id: string }> {
  assertMember(viewer);
  const parsed = groupSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  if (!(await consume(db, `group:create:${viewer.id}`, 5, 24 * 60 * 60))) {
    throw new AppError("rate_limited", "グループの作成は 1 日 5 件までです。");
  }
  return db.transaction(async (tx) => {
    const [g] = await tx.insert(groups).values({ ...parsed.data, createdById: viewer.id }).returning({ id: groups.id });
    await tx.insert(groupMembers).values({ groupId: g!.id, userId: viewer.id, role: "owner", status: "active", approvedAt: new Date() });
    await audit(tx, { actorId: viewer.id, action: "group.create", targetType: "group", targetId: g!.id });
    return { id: g!.id };
  });
}

/** 全会員が見られるグループの一覧（閉じたものは、自分が入っているものだけ） */
export async function listGroups(db: Db, viewer: Viewer) {
  assertMember(viewer);
  const memberCount = sql<number>`(SELECT count(*)::int FROM group_members gm JOIN users u ON u.id = gm.user_id
    WHERE gm.group_id = ${groups.id} AND gm.status = 'active' AND u.status = 'active')`;
  const rows = await db
    .select({ g: groups, memberCount, myRole: groupMembers.role, myStatus: groupMembers.status })
    .from(groups)
    .leftJoin(groupMembers, and(eq(groupMembers.groupId, groups.id), eq(groupMembers.userId, viewer.id)))
    .where(sql`(${groups.archivedAt} IS NULL OR ${groupMembers.status} = 'active')`)
    .orderBy(desc(groups.createdAt));
  return rows.map((r) => ({
    id: r.g.id,
    name: r.g.name,
    description: r.g.description,
    joinPolicy: r.g.joinPolicy,
    archived: !!r.g.archivedAt,
    memberCount: r.memberCount,
    me: r.myStatus ? ({ role: r.myRole!, status: r.myStatus } as Membership) : null,
  }));
}

export async function getGroup(db: Db, viewer: Viewer, groupId: string) {
  assertMember(viewer);
  const { g, me } = await loadGroup(db, viewer, groupId);
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.status, "active"), eq(users.status, "active")));
  const active = me?.status === "active";
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    joinPolicy: g.joinPolicy,
    archived: !!g.archivedAt,
    memberCount: n,
    me,
    canPost: active && !g.archivedAt,
    canManage: isManager(me) && !g.archivedAt,
    isOwner: active && me?.role === "owner",
    canArchive: (active && me?.role === "owner") || isAdmin(viewer),
    /** サイトの管理者は、メンバー一覧を見てオーナーを指定し直せる（グループの投稿は見えない） */
    adminView: isAdmin(viewer),
  };
}

/** メンバー一覧。アクティブなメンバーだけが見られる。管理役には参加申請も見せる。ブロック関係の人は出さない */
export async function listGroupMembers(db: Db, viewer: Viewer, groupId: string) {
  assertMember(viewer);
  const { g, me } = await loadGroup(db, viewer, groupId);
  if (me?.status !== "active" && !isAdmin(viewer)) throw notFound("グループが見つかりません。");
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, avatarMediaId: profiles.avatarMediaId, role: groupMembers.role, status: groupMembers.status, since: groupMembers.createdAt })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        eq(groupMembers.groupId, g.id),
        eq(users.status, "active"),
        isManager(me) ? undefined : eq(groupMembers.status, "active"),
        sql`(${users.id} = ${viewer.id} OR NOT ${blockedBetween(viewer.id, sql`${users.id}`)})`,
      ),
    )
    .orderBy(sql`CASE ${groupMembers.role} WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END`, asc(groupMembers.createdAt));
  return { active: rows.filter((r) => r.status === "active"), pending: rows.filter((r) => r.status === "pending") };
}

// ───────── 参加・退出 ─────────

export async function joinGroup(db: Db, viewer: Viewer, groupId: string): Promise<"joined" | "requested"> {
  assertMember(viewer);
  const { g, me } = await loadGroup(db, viewer, groupId);
  if (g.archivedAt) throw conflict("このグループは閉じられています。");
  if (me) return me.status === "active" ? "joined" : "requested";
  const [banned] = await db.select({ one: sql`1` }).from(groupBans).where(and(eq(groupBans.groupId, g.id), eq(groupBans.userId, viewer.id)));
  if (banned) throw forbidden("このグループには参加できません。");
  if (!(await consume(db, `group:join:${viewer.id}`, 30, 60 * 60))) {
    throw new AppError("rate_limited", "短時間の操作が多すぎます。少し時間をおいてください。");
  }
  const open = g.joinPolicy === "open";
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(groupMembers)
      .values({ groupId: g.id, userId: viewer.id, role: "member", status: open ? "active" : "pending", approvedAt: open ? new Date() : null })
      .onConflictDoNothing()
      .returning({ userId: groupMembers.userId });
    if (inserted.length && !open) {
      for (const id of await managerIds(tx, g.id)) {
        await notify(tx, { userId: id, type: "group_join_request", actorId: viewer.id, data: { groupId: g.id, groupName: g.name } });
      }
    }
    return open ? "joined" : "requested";
  });
}

/** 退出（参加申請の取り消しも同じ）。オーナーは先にオーナーを移す */
export async function leaveGroup(db: Db, viewer: Viewer, groupId: string) {
  assertMember(viewer);
  const { g, me } = await loadGroup(db, viewer, groupId);
  if (!me) return;
  if (me.role === "owner") throw conflict("オーナーは退出できません。先に、ほかのメンバーへオーナーを移してください。");
  await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, viewer.id)));
}

// ───────── 管理 ─────────

async function assertManager(db: DbOrTx, viewer: Viewer, groupId: string) {
  assertMember(viewer);
  const { g, me } = await loadGroup(db, viewer, groupId);
  if (g.archivedAt) throw conflict("このグループは閉じられています。");
  if (!isManager(me)) throw forbidden("グループのオーナーかモデレーターだけが行える操作です。");
  return { g, me: me! };
}

async function targetMembership(db: DbOrTx, groupId: string, userId: string) {
  if (!z.uuid().safeParse(userId).success) throw notFound("メンバーが見つかりません。");
  const m = await membership(db, groupId, userId);
  if (!m) throw notFound("メンバーが見つかりません。");
  return m;
}

export async function respondJoinRequest(db: Db, viewer: Viewer, groupId: string, userId: string, accept: boolean) {
  const { g } = await assertManager(db, viewer, groupId);
  const t = await targetMembership(db, g.id, userId);
  if (t.status !== "pending") throw conflict("参加申請が見つかりません。");
  await db.transaction(async (tx) => {
    const where = and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId), eq(groupMembers.status, "pending"));
    if (!accept) {
      await tx.delete(groupMembers).where(where);
      return;
    }
    const [done] = await tx.update(groupMembers).set({ status: "active", approvedAt: new Date() }).where(where).returning({ userId: groupMembers.userId });
    if (!done) throw conflict("参加申請が見つかりません。");
    await notify(tx, { userId, type: "group_join_approved", actorId: viewer.id, data: { groupId: g.id, groupName: g.name } });
  });
}

/** メンバーを外す。オーナーは外せない。モデレーターを外せるのはオーナーだけ */
export async function removeMember(db: Db, viewer: Viewer, groupId: string, userId: string) {
  const { g, me } = await assertManager(db, viewer, groupId);
  if (userId === viewer.id) throw invalid("自分を外すときは「退出」を使ってください。");
  const t = await targetMembership(db, g.id, userId);
  if (t.role === "owner") throw forbidden("オーナーは外せません。");
  if (t.role === "moderator" && me.role !== "owner") throw forbidden("モデレーターを外せるのはオーナーだけです。");
  await db.transaction(async (tx) => {
    // 確認した役割のままのときだけ外す（同時にオーナーを移された人を外してしまわないように）
    const allowed = me.role === "owner" ? ["member", "moderator"] : ["member"];
    const [gone] = await tx
      .delete(groupMembers)
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId), inArray(groupMembers.role, allowed as GroupRole[])))
      .returning({ userId: groupMembers.userId });
    if (!gone) throw conflict("相手の役割が変わったため、外せませんでした。");
    // 外した人は、管理役が解除するまで入り直せない
    await tx.insert(groupBans).values({ groupId: g.id, userId, bannedById: viewer.id }).onConflictDoNothing();
    await audit(tx, { actorId: viewer.id, action: "group.remove_member", targetType: "group", targetId: g.id, meta: { userId } });
  });
}

/** 外した人の一覧（管理役だけ） */
export async function listGroupBans(db: Db, viewer: Viewer, groupId: string) {
  const { g } = await assertManager(db, viewer, groupId);
  return db
    .select({ id: users.id, displayName: users.displayName, since: groupBans.createdAt })
    .from(groupBans)
    .innerJoin(users, eq(users.id, groupBans.userId))
    .where(eq(groupBans.groupId, g.id))
    .orderBy(desc(groupBans.createdAt));
}

/** 外した人の解除（また参加・申請できるようになる。自動では戻さない） */
export async function unbanMember(db: Db, viewer: Viewer, groupId: string, userId: string) {
  const { g } = await assertManager(db, viewer, groupId);
  if (!z.uuid().safeParse(userId).success) throw notFound();
  await db.delete(groupBans).where(and(eq(groupBans.groupId, g.id), eq(groupBans.userId, userId)));
  await audit(db, { actorId: viewer.id, action: "group.unban_member", targetType: "group", targetId: g.id, meta: { userId } });
}

export async function setMemberRole(db: Db, viewer: Viewer, groupId: string, userId: string, role: "moderator" | "member") {
  const { g, me } = await assertManager(db, viewer, groupId);
  if (me.role !== "owner") throw forbidden("モデレーターの任命はオーナーだけが行えます。");
  if (role !== "moderator" && role !== "member") throw invalid("役割の指定が正しくありません。");
  const t = await targetMembership(db, g.id, userId);
  if (t.role === "owner" || t.status !== "active") throw conflict("参加中のメンバーだけ役割を変えられます。");
  // オーナーの行は決して書き換えない（同時にオーナーを移された場合に備えて条件に入れる）
  const [done] = await db
    .update(groupMembers)
    .set({ role })
    .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId), eq(groupMembers.status, "active"), inArray(groupMembers.role, ["member", "moderator"])))
    .returning({ userId: groupMembers.userId });
  if (!done) throw conflict("相手の役割が変わったため、変更できませんでした。");
}

/** オーナーを移す。移した後、元のオーナーはモデレーターになる（オーナーが 2 人にならないよう条件付きで先に降格） */
export async function transferGroupOwnership(db: Db, viewer: Viewer, groupId: string, userId: string) {
  const { g, me } = await assertManager(db, viewer, groupId);
  if (me.role !== "owner") throw forbidden("オーナーだけが行える操作です。");
  if (userId === viewer.id) throw invalid("自分自身には移せません。");
  const t = await targetMembership(db, g.id, userId);
  if (t.status !== "active") throw conflict("参加中のメンバーにだけ移せます。");
  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  if (u?.status !== "active") throw conflict("参加中のメンバーにだけ移せます。");
  await db.transaction(async (tx) => {
    const [demoted] = await tx
      .update(groupMembers)
      .set({ role: "moderator" })
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, viewer.id), eq(groupMembers.role, "owner")))
      .returning({ userId: groupMembers.userId });
    if (!demoted) throw conflict("すでにオーナーではありません。");
    const [promoted] = await tx
      .update(groupMembers)
      .set({ role: "owner" })
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId), eq(groupMembers.status, "active")))
      .returning({ userId: groupMembers.userId });
    if (!promoted) throw conflict("相手の状態が変わったため、移せませんでした。");
    await audit(tx, { actorId: viewer.id, action: "group.transfer_ownership", targetType: "group", targetId: g.id, meta: { to: userId } });
  });
}

export async function updateGroup(db: Db, viewer: Viewer, groupId: string, raw: z.input<typeof groupSchema>) {
  const { g } = await assertManager(db, viewer, groupId);
  const parsed = groupSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  await db.update(groups).set({ ...parsed.data, updatedAt: new Date() }).where(eq(groups.id, g.id));
  // 承認制から参加自由に変えたら、待っている申請はそのまま承認する
  if (g.joinPolicy === "approval" && parsed.data.joinPolicy === "open") {
    await db
      .update(groupMembers)
      .set({ status: "active", approvedAt: new Date() })
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.status, "pending")));
  }
}

/** グループを閉じる（投稿は誰にも見えなくなる。削除はしない）。オーナーか、サイトの管理者 */
export async function setGroupArchived(db: Db, viewer: Viewer, groupId: string, archived: boolean) {
  assertMember(viewer);
  const { g, me } = await loadGroup(db, viewer, groupId);
  const owner = me?.status === "active" && me.role === "owner";
  if (!owner && !isAdmin(viewer)) throw forbidden("グループを閉じられるのは、オーナーかサイトの管理者だけです。");
  if (!archived && !(await hasActiveOwner(db, g.id))) {
    throw conflict("オーナーがいないため再開できません。先にサイトの管理者がオーナーを指定してください。");
  }
  await db.update(groups).set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where(eq(groups.id, g.id));
  await audit(db, { actorId: viewer.id, action: archived ? "group.archive" : "group.unarchive", targetType: "group", targetId: g.id, meta: { byAdmin: !owner } });
}

async function hasActiveOwner(db: DbOrTx, groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(groupMembers)
    .innerJoin(users, eq(users.id, groupMembers.userId))
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.role, "owner"), eq(groupMembers.status, "active"), eq(users.status, "active")));
  return !!row;
}

/**
 * サイトの管理者によるオーナーの指定（オーナーが退会・停止してグループを管理できなくなったとき）。
 * 相手はそのグループのアクティブなメンバー。いまのオーナーがいればモデレーターにする。監査ログに残す。
 */
export async function assignGroupOwnerByAdmin(db: Db, viewer: Viewer, groupId: string, userId: string) {
  assertMember(viewer);
  if (!isAdmin(viewer)) throw forbidden("サイトの管理者だけが行える操作です。");
  const { g } = await loadGroup(db, viewer, groupId);
  const t = await targetMembership(db, g.id, userId);
  const [u] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
  if (t.status !== "active" || u?.status !== "active") throw conflict("参加中のメンバーだけをオーナーにできます。");
  await db.transaction(async (tx) => {
    await tx.update(groupMembers).set({ role: "moderator" }).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.role, "owner")));
    const [done] = await tx
      .update(groupMembers)
      .set({ role: "owner" })
      .where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, userId), eq(groupMembers.status, "active")))
      .returning({ userId: groupMembers.userId });
    if (!done) throw conflict("相手の状態が変わったため、指定できませんでした。");
    await audit(tx, { actorId: viewer.id, action: "group.assign_owner_by_admin", targetType: "group", targetId: g.id, meta: { to: userId } });
  });
}

/** 退会の前に確認：グループ（閉じたものも含む）のオーナーなら、先に移してもらう */
export async function ownedGroups(db: DbOrTx, userId: string): Promise<string[]> {
  const rows = await db
    .select({ name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.userId, userId), eq(groupMembers.role, "owner")));
  return rows.map((r) => r.name);
}

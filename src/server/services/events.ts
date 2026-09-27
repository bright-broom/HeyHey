import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { eventRsvps, events, groups, profiles, users } from "../db/schema";
import { AppError, forbidden, invalid, notFound } from "../lib/errors";
import { assertAdmin, assertMember, isAdmin } from "../lib/policy";
import { activeInOpenGroup, blockedBetween, visibleEvent } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { notify } from "./notifications";
import { consume } from "./ratelimit";

/**
 * イベント（F-17）：日時・場所・出欠。
 * 見える範囲の判定は visibleEvent の 1 か所（一覧・詳細・出欠・参加者の一覧のすべてが通る）。
 */
export const RSVP_LABEL = { going: "参加", maybe: "未定", declined: "不参加" } as const;
export type RsvpStatus = keyof typeof RSVP_LABEL;

const JST_OFFSET = "+09:00";
/** 画面の日時入力（YYYY-MM-DDTHH:mm、日本時間）を Date にする */
export function parseJstLocal(v: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(`${v}:00${JST_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Date を画面の日時入力の値（日本時間）にする */
export function toJstLocal(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16);
}

const eventSchema = z.object({
  title: z.string().trim().min(1, "タイトルを入れてください。").max(100, "タイトルは 100 文字までです。"),
  description: z.string().trim().max(2000, "説明は 2000 文字までです。"),
  location: z.string().trim().max(200, "場所は 200 文字までです。"),
  startsAt: z.string(),
  endsAt: z.string(),
  groupId: z.string(),
});
export type EventInput = z.input<typeof eventSchema>;

function parseEvent(raw: EventInput) {
  const p = eventSchema.safeParse(raw);
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? "入力内容を確認してください。");
  const startsAt = parseJstLocal(p.data.startsAt);
  if (!startsAt) throw invalid("開始日時を入れてください。");
  const endsAt = p.data.endsAt ? parseJstLocal(p.data.endsAt) : null;
  if (p.data.endsAt && !endsAt) throw invalid("終了日時の形式が正しくありません。");
  if (endsAt && endsAt <= startsAt) throw invalid("終了日時は開始日時より後にしてください。");
  return { title: p.data.title, description: p.data.description, location: p.data.location, startsAt, endsAt, groupId: p.data.groupId || null };
}

/** グループのイベントは、そのグループのアクティブなメンバーだけが作れる */
async function assertCanPostToGroup(db: Db, viewer: Viewer, groupId: string | null) {
  if (!groupId) return;
  if (!z.uuid().safeParse(groupId).success) throw notFound("グループが見つかりません。");
  const [ok] = await db.select({ one: sql`1` }).from(users).where(and(eq(users.id, viewer.id), activeInOpenGroup(viewer.id, sql`${groupId}::uuid`)));
  if (!ok) throw notFound("グループが見つかりません。");
}

export async function createEvent(db: Db, viewer: Viewer, raw: EventInput): Promise<{ id: string }> {
  assertMember(viewer);
  const e = parseEvent(raw);
  if (e.startsAt.getTime() < Date.now() - 60 * 60 * 1000) throw invalid("開始日時が過ぎています。");
  await assertCanPostToGroup(db, viewer, e.groupId);
  if (!(await consume(db, `event:${viewer.id}`, 10, 24 * 60 * 60))) {
    throw new AppError("rate_limited", "イベントを作れるのは 1 日 10 件までです。");
  }
  const [row] = await db.insert(events).values({ ...e, creatorId: viewer.id }).returning({ id: events.id });
  // 作った人は参加にしておく
  await db.insert(eventRsvps).values({ eventId: row!.id, userId: viewer.id, status: "going" });
  return { id: row!.id };
}

async function ownEvent(db: Db, viewer: Viewer, eventId: string) {
  if (!z.uuid().safeParse(eventId).success) throw notFound();
  const [e] = await db.select().from(events).where(and(eq(events.id, eventId), visibleEvent(viewer.id)));
  if (!e) throw notFound();
  if (e.creatorId !== viewer.id) throw forbidden("自分が作ったイベントだけ変更できます。");
  return e;
}

export async function updateEvent(db: Db, viewer: Viewer, eventId: string, raw: Omit<EventInput, "groupId">) {
  assertMember(viewer);
  const e = await ownEvent(db, viewer, eventId);
  const next = parseEvent({ ...raw, groupId: e.groupId ?? "" });
  await db
    .update(events)
    .set({ title: next.title, description: next.description, location: next.location, startsAt: next.startsAt, endsAt: next.endsAt, updatedAt: new Date() })
    .where(eq(events.id, e.id));
}

/** 中止（取り消しで再開）。出欠を「参加・未定」にしていた人に知らせる */
export async function setEventCanceled(db: Db, viewer: Viewer, eventId: string, canceled: boolean) {
  assertMember(viewer);
  const e = await ownEvent(db, viewer, eventId);
  if (!!e.canceledAt === canceled) return;
  await db.transaction(async (tx) => {
    await tx.update(events).set({ canceledAt: canceled ? new Date() : null, updatedAt: new Date() }).where(eq(events.id, e.id));
    if (canceled) {
      const people = await tx
        .select({ userId: eventRsvps.userId })
        .from(eventRsvps)
        .where(and(eq(eventRsvps.eventId, e.id), inArray(eventRsvps.status, ["going", "maybe"])));
      for (const p of people) await notify(tx, { userId: p.userId, type: "event_canceled", actorId: viewer.id, data: { eventId: e.id, title: e.title } });
    }
  });
}

export async function deleteEvent(db: Db, viewer: Viewer, eventId: string) {
  assertMember(viewer);
  const e = await ownEvent(db, viewer, eventId);
  await db.update(events).set({ deletedAt: new Date() }).where(eq(events.id, e.id));
}

/** 管理者による非表示・再表示（監査ログに残す） */
export async function setEventHidden(db: Db, viewer: Viewer, eventId: string, hidden: boolean, reason: string) {
  assertAdmin(viewer);
  if (!z.uuid().safeParse(eventId).success) throw notFound();
  if (hidden && !reason.trim()) throw invalid("非表示にする理由を入れてください。");
  const [e] = await db.select({ id: events.id, creatorId: events.creatorId }).from(events).where(and(eq(events.id, eventId), isNull(events.deletedAt)));
  if (!e) throw notFound();
  await db.transaction(async (tx) => {
    await tx.update(events).set({ hiddenAt: hidden ? new Date() : null }).where(eq(events.id, e.id));
    await audit(tx, { actorId: viewer.id, action: hidden ? "event.hide" : "event.unhide", targetType: "event", targetId: e.id, reason: reason.trim() || null });
  });
}

export async function setRsvp(db: Db, viewer: Viewer, eventId: string, status: string) {
  assertMember(viewer);
  if (!(status in RSVP_LABEL)) throw invalid("出欠の選び方が正しくありません。");
  if (!z.uuid().safeParse(eventId).success) throw notFound();
  const [e] = await db.select().from(events).where(and(eq(events.id, eventId), visibleEvent(viewer.id)));
  if (!e) throw notFound();
  if (e.canceledAt) throw invalid("中止されたイベントです。");
  if ((e.endsAt ?? e.startsAt) < new Date()) throw invalid("終わったイベントです。");
  const [prev] = await db.select({ status: eventRsvps.status }).from(eventRsvps).where(and(eq(eventRsvps.eventId, e.id), eq(eventRsvps.userId, viewer.id)));
  await db
    .insert(eventRsvps)
    .values({ eventId: e.id, userId: viewer.id, status: status as RsvpStatus })
    .onConflictDoUpdate({ target: [eventRsvps.eventId, eventRsvps.userId], set: { status: status as RsvpStatus, updatedAt: new Date() } });
  // 新しく「参加」になったときだけ、作った人に知らせる
  if (status === "going" && prev?.status !== "going") {
    await notify(db, { userId: e.creatorId, type: "event_rsvp", actorId: viewer.id, data: { eventId: e.id, title: e.title } });
  }
}

export type EventSummary = {
  id: string;
  title: string;
  location: string;
  startsAt: Date;
  endsAt: Date | null;
  canceled: boolean;
  hidden: boolean;
  group: { id: string; name: string } | null;
  going: number;
  myRsvp: RsvpStatus | null;
};

/** 見える参加者だけを数える（ブロック関係・停止中の人は数にも出さない） */
const countableRsvp = (viewerId: string) =>
  sql`EXISTS (SELECT 1 FROM users ru WHERE ru.id = ${eventRsvps.userId} AND ru.status = 'active') AND (${eventRsvps.userId} = ${viewerId} OR NOT ${blockedBetween(viewerId, sql`${eventRsvps.userId}`)})`;

/** これからのイベント（開始が近い順）、または終わったイベント（新しい順） */
export async function listEvents(db: Db, viewer: Viewer, opts: { past?: boolean; groupId?: string } = {}): Promise<EventSummary[]> {
  assertMember(viewer);
  const now = new Date();
  const ended = sql`coalesce(${events.endsAt}, ${events.startsAt})`;
  const rows = await db
    .select({ e: events, groupName: groups.name })
    .from(events)
    .leftJoin(groups, eq(groups.id, events.groupId))
    .where(
      and(
        visibleEvent(viewer.id),
        opts.past ? lt(ended, now) : gte(ended, now),
        opts.groupId && z.uuid().safeParse(opts.groupId).success ? eq(events.groupId, opts.groupId) : undefined,
      ),
    )
    .orderBy(opts.past ? desc(events.startsAt) : asc(events.startsAt))
    .limit(100);
  return summarize(db, viewer, rows);
}

async function summarize(db: Db, viewer: Viewer, rows: { e: typeof events.$inferSelect; groupName: string | null }[]): Promise<EventSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.e.id);
  const [counts, mine] = await Promise.all([
    db
      .select({ eventId: eventRsvps.eventId, n: sql<number>`count(*)::int` })
      .from(eventRsvps)
      .where(and(inArray(eventRsvps.eventId, ids), eq(eventRsvps.status, "going"), countableRsvp(viewer.id)))
      .groupBy(eventRsvps.eventId),
    db.select({ eventId: eventRsvps.eventId, status: eventRsvps.status }).from(eventRsvps).where(and(inArray(eventRsvps.eventId, ids), eq(eventRsvps.userId, viewer.id))),
  ]);
  return rows.map(({ e, groupName }) => ({
    id: e.id,
    title: e.title,
    location: e.location,
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    canceled: !!e.canceledAt,
    hidden: !!e.hiddenAt,
    group: e.groupId ? { id: e.groupId, name: groupName ?? "グループ" } : null,
    going: counts.find((c) => c.eventId === e.id)?.n ?? 0,
    myRsvp: mine.find((m) => m.eventId === e.id)?.status ?? null,
  }));
}

/** 管理者は、非表示にしたイベントも開ける（再表示するため）。グループの範囲とブロックは変えない */
function hiddenButOtherwiseVisible(viewerId: string) {
  return and(
    isNotNull(events.hiddenAt),
    isNull(events.deletedAt),
    or(isNull(events.groupId), activeInOpenGroup(viewerId, events.groupId)),
    sql`NOT ${blockedBetween(viewerId, sql`${events.creatorId}`)}`,
  );
}

export async function getEvent(db: Db, viewer: Viewer, eventId: string) {
  assertMember(viewer);
  if (!z.uuid().safeParse(eventId).success) return null;
  const admin: boolean = isAdmin(viewer);
  const [row] = await db
    .select({ e: events, groupName: groups.name, creatorName: users.displayName, creatorStatus: users.status, creatorAvatar: profiles.avatarMediaId })
    .from(events)
    .leftJoin(groups, eq(groups.id, events.groupId))
    .innerJoin(users, eq(users.id, events.creatorId))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(events.id, eventId), admin ? or(visibleEvent(viewer.id), hiddenButOtherwiseVisible(viewer.id)) : visibleEvent(viewer.id)));
  if (!row) return null;
  const [summary] = await summarize(db, viewer, [{ e: row.e, groupName: row.groupName }]);
  const people = await db
    .select({ id: users.id, displayName: users.displayName, avatarMediaId: profiles.avatarMediaId, status: eventRsvps.status })
    .from(eventRsvps)
    .innerJoin(users, eq(users.id, eventRsvps.userId))
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(eventRsvps.eventId, row.e.id), inArray(eventRsvps.status, ["going", "maybe"]), countableRsvp(viewer.id)))
    .orderBy(asc(eventRsvps.updatedAt));
  const withdrawn = row.creatorStatus === "withdrawn";
  return {
    ...summary!,
    description: row.e.description,
    isMine: row.e.creatorId === viewer.id,
    creator: withdrawn ? { id: null, displayName: "退会したメンバー", avatarMediaId: null } : { id: row.e.creatorId, displayName: row.creatorName, avatarMediaId: row.creatorAvatar },
    attendees: people.map((p) => ({ id: p.id, displayName: p.displayName, avatarMediaId: p.avatarMediaId, status: p.status })),
  };
}

/** 作れるグループ（自分がアクティブなメンバーで、閉じていない） */
export async function groupsForEvents(db: Db, viewer: Viewer) {
  assertMember(viewer);
  return db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(activeInOpenGroup(viewer.id, sql`${groups.id}`))
    .orderBy(asc(groups.name));
}

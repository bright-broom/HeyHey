import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { activitySnapshots, comments, posts, users } from "../db/schema";
import { assertAdmin, PHASE3_WEEKLY_ACTIVE_RATE } from "../lib/policy";
import type { Viewer } from "../lib/viewer";

/**
 * 利用状況（週次アクティブ率など）。Phase 2 → 3 に進む条件「週次アクティブ率 40% 以上」の判断材料。
 * 人数だけを数え、誰がかは残さない。
 */
const WEEK = 7 * 24 * 60 * 60 * 1000;

/** now から直近 7 日の数字。ダッシュボードの「今週」と、毎日の記録の両方で使う */
export async function activityCounts(db: Db, now = new Date()) {
  const weekAgo = new Date(now.getTime() - WEEK);
  const n = sql<number>`count(*)::int`;
  const count = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
  const [activeMembers, weeklyActiveMembers, postsWeek, commentsWeek] = await Promise.all([
    count(db.select({ n }).from(users).where(eq(users.status, "active"))),
    count(db.select({ n }).from(users).where(and(eq(users.status, "active"), gt(users.lastSeenAt, weekAgo)))),
    count(db.select({ n }).from(posts).where(and(gt(posts.createdAt, weekAgo), isNull(posts.deletedAt)))),
    count(db.select({ n }).from(comments).where(and(gt(comments.createdAt, weekAgo), isNull(comments.deletedAt)))),
  ]);
  return { activeMembers, weeklyActiveMembers, postsWeek, commentsWeek };
}

/** 日本時間の日付（YYYY-MM-DD） */
export const jstDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** その日の数字を 1 行残す。同じ日に何度流しても最初の 1 行だけ（定期処理のやり直しで数字が揺れない） */
export async function recordActivitySnapshot(db: Db, now = new Date()): Promise<boolean> {
  const c = await activityCounts(db, now);
  const inserted = await db
    .insert(activitySnapshots)
    .values({ day: jstDay(now), ...c })
    .onConflictDoNothing()
    .returning({ day: activitySnapshots.day });
  return inserted.length > 0;
}

export type WeeklyActivity = { day: string; activeMembers: number; weeklyActiveMembers: number; rate: number | null; reached: boolean };

/**
 * 週ごと（月曜はじまり）の週次アクティブ率。各週の最後に記録した日の数字を使う。古い順。
 * 定期処理が止まった週は抜ける（数字を作らない）。
 */
export async function weeklyActivityTrend(db: Db, viewer: Viewer, weeks = 8): Promise<WeeklyActivity[]> {
  assertAdmin(viewer);
  const week = sql`date_trunc('week', ${activitySnapshots.day}::timestamp)`;
  const rows = await db
    .selectDistinctOn([week], { day: activitySnapshots.day, activeMembers: activitySnapshots.activeMembers, weeklyActiveMembers: activitySnapshots.weeklyActiveMembers })
    .from(activitySnapshots)
    .orderBy(sql`${week} desc`, sql`${activitySnapshots.day} desc`)
    .limit(weeks);
  return rows.reverse().map((r) => {
    const rate = r.activeMembers ? r.weeklyActiveMembers / r.activeMembers : null;
    return { ...r, rate, reached: rate != null && rate >= PHASE3_WEEKLY_ACTIVE_RATE };
  });
}

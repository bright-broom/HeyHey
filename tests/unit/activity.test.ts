import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { activitySnapshots, users } from "@/server/db/schema";
import { activityCounts, jstDay, recordActivitySnapshot, weeklyActivityTrend } from "@/server/services/activity";
import { runDailyMaintenance } from "@/server/services/maintenance";
import { db, makeUser } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const snap = (day: string, active: number, weekly: number) => ({ day, activeMembers: active, weeklyActiveMembers: weekly, postsWeek: 0, commentsWeek: 0 });

describe("週次アクティブ率の記録（Phase 3 に進む判断の材料）", () => {
  it("直近 7 日にアクセスした会員だけを数える。停止中の人は会員にも数えない", async () => {
    const before = await activityCounts(d);
    const recent = await makeUser(d);
    await makeUser(d); // 一度も来ていない
    const stale = await makeUser(d);
    const suspended = await makeUser(d, { status: "suspended" });
    await d.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, recent.user.id));
    await d.update(users).set({ lastSeenAt: new Date(Date.now() - 8 * 86400_000) }).where(eq(users.id, stale.user.id));
    await d.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, suspended.user.id));

    const after = await activityCounts(d);
    expect(after.activeMembers - before.activeMembers).toBe(3);
    expect(after.weeklyActiveMembers - before.weeklyActiveMembers).toBe(1);
  });

  it("日本時間の日付で 1 日 1 行だけ残す（同じ日にやり直しても、最初の数字のまま）", async () => {
    // UTC 15:30 は日本時間では翌日
    const now = new Date("2031-03-01T15:30:00Z");
    expect(jstDay(now)).toBe("2031-03-02");
    expect(await recordActivitySnapshot(d, now)).toBe(true);
    const [first] = await d.select().from(activitySnapshots).where(eq(activitySnapshots.day, "2031-03-02"));
    expect(first!.activeMembers).toBe((await activityCounts(d, now)).activeMembers);

    await makeUser(d);
    expect(await recordActivitySnapshot(d, new Date("2031-03-02T10:00:00Z"))).toBe(false);
    const rows = await d.select().from(activitySnapshots).where(eq(activitySnapshots.day, "2031-03-02"));
    expect(rows).toEqual([first]);
  });

  it("毎日の定期処理が記録する", async () => {
    const now = new Date("2031-04-01T03:00:00Z");
    expect((await runDailyMaintenance(d, now)).activityRecorded).toBe(true);
    expect((await runDailyMaintenance(d, now)).activityRecorded).toBe(false);
    expect(await d.select().from(activitySnapshots).where(eq(activitySnapshots.day, "2031-04-01"))).toHaveLength(1);
  });

  it("推移は週ごと（月曜はじまり）にその週の最後の記録を使い、古い順に並べる。記録のない週は作らない", async () => {
    // 2032-01-05 は月曜
    await d.insert(activitySnapshots).values([
      snap("2032-01-05", 10, 1),
      snap("2032-01-11", 10, 3), // 同じ週の日曜（こちらを使う）
      snap("2032-01-12", 10, 4),
      // 2032-01-19 の週は定期処理が止まっていた
      snap("2032-01-28", 10, 5),
      snap("2032-02-02", 0, 0),
    ]);
    const admin = await makeUser(d, { role: "admin" });
    const trend = await weeklyActivityTrend(d, admin.viewer, 4);
    expect(trend.map((w) => w.day)).toEqual(["2032-01-11", "2032-01-12", "2032-01-28", "2032-02-02"]);
    expect(trend.map((w) => w.rate)).toEqual([0.3, 0.4, 0.5, null]);
    expect(trend.map((w) => w.reached)).toEqual([false, true, true, false]);
  });

  it("推移を見られるのは管理者以上", async () => {
    const m = await makeUser(d);
    await expect(weeklyActivityTrend(d, m.viewer)).rejects.toMatchObject({ code: "forbidden" });
  });
});

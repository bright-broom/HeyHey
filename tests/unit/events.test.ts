import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditLogs, notifications, users } from "@/server/db/schema";
import { blockUser } from "@/server/services/blocks";
import { createEvent, getEvent, listEvents, parseJstLocal, setEventCanceled, setEventHidden, setRsvp, toJstLocal, updateEvent } from "@/server/services/events";
import { createGroup, joinGroup } from "@/server/services/groups";
import { listNotifications } from "@/server/services/notifications";
import { db, makeUser } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const inDays = (n: number) => toJstLocal(new Date(Date.now() + n * 86400_000));
const input = (o: Partial<Parameters<typeof createEvent>[2]> = {}) => ({ title: "読書会", description: "", location: "駅前", startsAt: inDays(3), endsAt: "", groupId: "", ...o });

describe("イベント（F-17）", () => {
  it("日時は日本時間で入れる", () => {
    expect(parseJstLocal("2031-01-02T09:30")!.toISOString()).toBe("2031-01-02T00:30:00.000Z");
    expect(toJstLocal(new Date("2031-01-02T00:30:00Z"))).toBe("2031-01-02T09:30");
    expect(parseJstLocal("2031-01-02 09:30")).toBeNull();
  });

  it("全会員向けのイベントは会員なら誰でも見えて、出欠を付けられる。作った人に参加を知らせる", async () => {
    const host = await makeUser(d);
    const guest = await makeUser(d);
    const { id } = await createEvent(d, host.viewer, input());
    expect((await listEvents(d, guest.viewer)).map((e) => e.id)).toContain(id);
    await setRsvp(d, guest.viewer, id, "going");
    await setRsvp(d, guest.viewer, id, "going"); // 2 回目は知らせない
    const e = await getEvent(d, guest.viewer, id);
    expect(e).toMatchObject({ going: 2, myRsvp: "going" });
    expect(e!.attendees.map((a) => a.id)).toEqual(expect.arrayContaining([host.user.id, guest.user.id]));
    const rsvps = await d.select().from(notifications).where(and(eq(notifications.userId, host.user.id), eq(notifications.type, "event_rsvp")));
    expect(rsvps).toHaveLength(1);
  });

  it("グループのイベントは、そのグループのメンバーにだけ見える。メンバーでない人は作れない", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const outsider = await makeUser(d);
    const { id: groupId } = await createGroup(d, owner.viewer, { name: `g-${Date.now()}`, description: "", joinPolicy: "open" });
    await joinGroup(d, member.viewer, groupId);
    const { id } = await createEvent(d, member.viewer, input({ groupId }));
    expect(await getEvent(d, owner.viewer, id)).not.toBeNull();
    expect(await getEvent(d, outsider.viewer, id)).toBeNull();
    expect((await listEvents(d, outsider.viewer)).map((e) => e.id)).not.toContain(id);
    await expect(setRsvp(d, outsider.viewer, id, "going")).rejects.toMatchObject({ code: "not_found" });
    await expect(createEvent(d, outsider.viewer, input({ groupId }))).rejects.toMatchObject({ code: "not_found" });
  });

  it("作った人とブロック関係なら見えない。ブロック相手は参加者の一覧にも数にも出ない", async () => {
    const host = await makeUser(d);
    const a = await makeUser(d);
    const b = await makeUser(d);
    const { id } = await createEvent(d, host.viewer, input());
    await setRsvp(d, a.viewer, id, "going");
    await setRsvp(d, b.viewer, id, "going");
    await blockUser(d, a.viewer, b.user.id);
    const seenByA = await getEvent(d, a.viewer, id);
    expect(seenByA!.attendees.map((x) => x.id)).not.toContain(b.user.id);
    expect(seenByA!.going).toBe(2);
    await blockUser(d, host.viewer, a.user.id);
    expect(await getEvent(d, a.viewer, id)).toBeNull();
  });

  it("中止すると、参加・未定の人に知らせる。中止中は出欠を付けられない", async () => {
    const host = await makeUser(d);
    const guest = await makeUser(d);
    const { id } = await createEvent(d, host.viewer, input({ title: "花見" }));
    await setRsvp(d, guest.viewer, id, "maybe");
    await setEventCanceled(d, host.viewer, id, true);
    const notes = await listNotifications(d, guest.viewer);
    expect(notes.find((n) => n.type === "event_canceled")).toMatchObject({ data: { eventId: id, title: "花見" } });
    await expect(setRsvp(d, guest.viewer, id, "going")).rejects.toMatchObject({ code: "invalid" });
    await expect(setEventCanceled(d, guest.viewer, id, false)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("作った人だけが変更できる。終了は開始より後、過去の開始は作れない", async () => {
    const host = await makeUser(d);
    const other = await makeUser(d);
    await expect(createEvent(d, host.viewer, input({ startsAt: inDays(-2) }))).rejects.toMatchObject({ code: "invalid" });
    await expect(createEvent(d, host.viewer, input({ startsAt: inDays(3), endsAt: inDays(2) }))).rejects.toMatchObject({ code: "invalid" });
    await expect(createEvent(d, host.viewer, input({ title: " " }))).rejects.toMatchObject({ code: "invalid" });
    const { id } = await createEvent(d, host.viewer, input());
    await expect(updateEvent(d, other.viewer, id, input({ title: "乗っ取り" }))).rejects.toMatchObject({ code: "forbidden" });
    await updateEvent(d, host.viewer, id, input({ title: "読書会（改）" }));
    expect((await getEvent(d, other.viewer, id))!.title).toBe("読書会（改）");
  });

  it("管理者は理由を付けて非表示にできる（監査ログに残る）。作った人にだけ見え、管理者は再表示できる", async () => {
    const host = await makeUser(d);
    const member = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { id } = await createEvent(d, host.viewer, input());
    await expect(setEventHidden(d, member.viewer, id, true, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(setEventHidden(d, admin.viewer, id, true, " ")).rejects.toMatchObject({ code: "invalid" });
    await setEventHidden(d, admin.viewer, id, true, "勧誘目的");
    expect(await getEvent(d, member.viewer, id)).toBeNull();
    expect(await getEvent(d, host.viewer, id)).toMatchObject({ hidden: true });
    expect(await getEvent(d, admin.viewer, id)).toMatchObject({ hidden: true });
    const [log] = await d.select().from(auditLogs).where(and(eq(auditLogs.action, "event.hide"), eq(auditLogs.targetId, id)));
    expect(log!.reason).toBe("勧誘目的");
    await setEventHidden(d, admin.viewer, id, false, "");
    expect(await getEvent(d, member.viewer, id)).not.toBeNull();
  });

  it("停止中の会員が作ったイベントは見えない。終わったイベントは「終わったもの」に出る", async () => {
    const host = await makeUser(d);
    const guest = await makeUser(d);
    const { id } = await createEvent(d, host.viewer, input());
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, host.user.id));
    expect(await getEvent(d, guest.viewer, id)).toBeNull();
    await d.update(users).set({ status: "active" }).where(eq(users.id, host.user.id));
    const { id: soon } = await createEvent(d, host.viewer, input({ startsAt: toJstLocal(new Date(Date.now() - 30 * 60_000)) }));
    expect((await listEvents(d, guest.viewer, { past: true })).map((e) => e.id)).toContain(soon);
    await expect(setRsvp(d, guest.viewer, soon, "going")).rejects.toMatchObject({ code: "invalid" });
  });
});

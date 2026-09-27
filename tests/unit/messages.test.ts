import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { messages, notifications, users } from "@/server/db/schema";
import { blockUser } from "@/server/services/blocks";
import { exportMyData } from "@/server/services/export";
import { withdraw } from "@/server/services/members";
import { deleteMessage, listConversations, openConversation, sendMessage, unreadMessageCount } from "@/server/services/messages";
import { db, makeUser, PASSWORD, refreshViewer } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const messageNotices = async (userId: string) => (await d.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "message")))).length;

describe("1 対 1 メッセージ（F-16）", () => {
  it("送ると相手の一覧に未読で出て、開くと既読になる", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await sendMessage(d, a.viewer, b.user.id, "こんにちは");
    await sendMessage(d, a.viewer, b.user.id, "  2 通目  ");
    const [c] = await listConversations(d, b.viewer);
    expect(c).toMatchObject({ partner: { id: a.user.id }, unread: 2, lastMessage: { body: "2 通目", mine: false } });
    expect(await unreadMessageCount(d, b.viewer)).toBe(2);
    expect(await unreadMessageCount(d, a.viewer)).toBe(0);

    const opened = await openConversation(d, b.viewer, a.user.id);
    expect(opened!.messages.map((m) => [m.body, m.mine])).toEqual([
      ["こんにちは", false],
      ["2 通目", false],
    ]);
    expect(await unreadMessageCount(d, b.viewer)).toBe(0);
    // 送った側から見ても同じやりとり（2 人で 1 つ）
    expect((await openConversation(d, a.viewer, b.user.id))!.messages).toHaveLength(2);
  });

  it("通知は、未読がない状態で届いた最初の 1 通だけ", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await sendMessage(d, a.viewer, b.user.id, "1");
    await sendMessage(d, a.viewer, b.user.id, "2");
    expect(await messageNotices(b.user.id)).toBe(1);
    await openConversation(d, b.viewer, a.user.id);
    await sendMessage(d, a.viewer, b.user.id, "3");
    expect(await messageNotices(b.user.id)).toBe(2);
  });

  it("当事者以外は、どの入口からも読めない・消せない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const outsider = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { id } = await sendMessage(d, a.viewer, b.user.id, "ふたりだけの話");
    for (const v of [outsider.viewer, admin.viewer]) {
      expect((await openConversation(d, v, a.user.id))!.messages).toEqual([]);
      expect((await openConversation(d, v, b.user.id))!.messages).toEqual([]);
      expect(await listConversations(d, v)).toEqual([]);
      await expect(deleteMessage(d, v, id)).rejects.toMatchObject({ code: "not_found" });
    }
    // 受け取った側も、相手のメッセージは消せない
    await expect(deleteMessage(d, b.viewer, id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("ブロックすると（どちら向きでも）やりとりは存在しないのと同じ。送れず、一覧にも未読にも出ない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await sendMessage(d, a.viewer, b.user.id, "やあ");
    await blockUser(d, b.viewer, a.user.id);
    await expect(sendMessage(d, a.viewer, b.user.id, "まだ？")).rejects.toMatchObject({ code: "not_found" });
    await expect(sendMessage(d, b.viewer, a.user.id, "x")).rejects.toMatchObject({ code: "not_found" });
    expect(await openConversation(d, a.viewer, b.user.id)).toBeNull();
    expect(await openConversation(d, b.viewer, a.user.id)).toBeNull();
    expect(await listConversations(d, a.viewer)).toEqual([]);
    expect(await listConversations(d, b.viewer)).toEqual([]);
    expect(await unreadMessageCount(d, b.viewer)).toBe(0);
  });

  it("会員でない人・停止中の人・規約同意前の人・自分には送れない。停止中の相手とのやりとりは一覧から外す", async () => {
    const a = await makeUser(d);
    const pending = await makeUser(d, { status: "pending" });
    const noTerms = await makeUser(d, { terms: false });
    const b = await makeUser(d);
    for (const to of [pending.user.id, noTerms.user.id, a.user.id, "00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      await expect(sendMessage(d, a.viewer, to, "x")).rejects.toMatchObject({ code: "not_found" });
    }
    await expect(sendMessage(d, pending.viewer, b.user.id, "x")).rejects.toBeTruthy();
    await sendMessage(d, a.viewer, b.user.id, "hi");
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, b.user.id));
    expect(await listConversations(d, a.viewer)).toEqual([]);
    expect(await openConversation(d, a.viewer, b.user.id)).toBeNull();
    await expect(sendMessage(d, a.viewer, b.user.id, "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("空・長すぎるメッセージは送れない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await expect(sendMessage(d, a.viewer, b.user.id, "   ")).rejects.toMatchObject({ code: "invalid" });
    await expect(sendMessage(d, a.viewer, b.user.id, "あ".repeat(2001))).rejects.toMatchObject({ code: "invalid" });
  });

  it("自分のメッセージを消すと、本文もその場で消える", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const { id } = await sendMessage(d, a.viewer, b.user.id, "うっかり");
    await deleteMessage(d, a.viewer, id);
    const [row] = await d.select().from(messages).where(eq(messages.id, id));
    expect(row!.body).toBe("");
    expect((await openConversation(d, b.viewer, a.user.id))!.messages[0]).toMatchObject({ deleted: true, body: "" });
    expect(await unreadMessageCount(d, b.viewer)).toBe(0);
  });

  it("退会（削除を選択）すると送ったメッセージの本文を消す。相手は退会したメンバーとして読めるが送れない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await sendMessage(d, a.viewer, b.user.id, "さようなら");
    await sendMessage(d, b.viewer, a.user.id, "元気でね");
    await withdraw(d, await refreshViewer(d, a.user.id), { password: PASSWORD, mode: "delete" });
    const [c] = await listConversations(d, b.viewer);
    expect(c!.partner).toMatchObject({ displayName: "退会したメンバー", withdrawn: true });
    const opened = await openConversation(d, b.viewer, a.user.id);
    expect(opened!.partner.canReceive).toBe(false);
    expect(opened!.messages.map((m) => m.body)).toEqual(["", "元気でね"]);
    await expect(sendMessage(d, b.viewer, a.user.id, "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("データの書き出しには、自分が送ったメッセージだけを入れる", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await sendMessage(d, a.viewer, b.user.id, "私の送信");
    await sendMessage(d, b.viewer, a.user.id, "相手の送信");
    const out = await exportMyData(d, a.viewer);
    expect(out.messagesSent.map((m) => [m.to, m.body])).toEqual([[b.user.id, "私の送信"]]);
    expect(JSON.stringify(out)).not.toContain("相手の送信");
  });
});

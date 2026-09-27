import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db/client";
import { Mp4Error, stripMp4Metadata } from "@/server/lib/mp4";
import { authorizeStagingUpload, cleanFileName, MAX_STAGED } from "@/server/services/attachments";
import { createEvent, getEvent, setEventHidden, setRsvp, toJstLocal } from "@/server/services/events";
import { createGroup, joinGroup, leaveGroup } from "@/server/services/groups";
import { openConversation, sendMessage } from "@/server/services/messages";
import { listFeed } from "@/server/services/posts";
import { storeFile } from "@/server/services/storage";
import { db, makeUser } from "./helpers";

/**
 * Phase 3 のセキュリティレビューの指摘（中 3 件・低 8 件）の回帰テスト
 */
let d: Db;
beforeAll(async () => {
  d = await db();
});

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (type: string, ...parts: Buffer[]) => {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(payload.length + 8), Buffer.from(type, "latin1"), payload]);
};
const FULL = Buffer.alloc(4); // version・flags
const hdlr = (t: string) => box("hdlr", FULL, Buffer.alloc(4), Buffer.from(t, "latin1"), Buffer.alloc(12), Buffer.from("\0"));
const stbl = (offset: number, size: number) =>
  box("stbl", box("stsc", FULL, u32(1), u32(1), u32(1), u32(1)), box("stsz", FULL, u32(0), u32(1), u32(size)), box("stco", FULL, u32(1), u32(offset)));
const trak = (handler: string, offset: number, size: number) =>
  box("trak", box("tkhd", FULL, u32(3_000_000_000), u32(3_000_000_000), Buffer.alloc(72)), box("mdia", box("mdhd", FULL, u32(3_000_000_001), u32(3_000_000_001), Buffer.alloc(12)), hdlr(handler), box("minf", stbl(offset, size))));

/** 映像トラックと、GoPro のような GPS のトラックを持つ MP4（mdat を moov より前に置く） */
function goproLike() {
  const ftyp = box("ftyp", Buffer.from("isom\0\0\0\0isommp41", "latin1"));
  const video = Buffer.from("VIDEOFRAME-DATA");
  const gps = Buffer.from("GPS+35.6812+139.7671");
  const mdat = box("mdat", video, gps);
  const videoAt = ftyp.length + 8;
  const moov = box("moov", box("mvhd", FULL, u32(3_000_000_002), u32(3_000_000_002), Buffer.alloc(12)), trak("vide", videoAt, video.length), trak("meta", videoAt + video.length, gps.length));
  return Buffer.concat([ftyp, mdat, moov]);
}

describe("M1：動画の位置情報は、トラックのデータや撮影日時まで消す", () => {
  it("映像・音声以外のトラックの中身（GPS）を mdat から消し、トラックも外す。映像のデータは残す", () => {
    const src = goproLike();
    expect(src.includes("GPS+35.68")).toBe(true);
    const out = stripMp4Metadata(Buffer.from(src));
    expect(out.length).toBe(src.length);
    expect(out.includes("GPS+35.68")).toBe(false);
    expect(out.includes("VIDEOFRAME-DATA")).toBe(true);
    expect(out.toString("latin1")).not.toContain("meta");
    // 作成日時（3,000,000,000 前後）が残っていない
    for (const n of [3_000_000_000, 3_000_000_001, 3_000_000_002]) expect(out.includes(u32(n))).toBe(false);
  });

  it("後から足していく形式（moof）や、壊れた動画は受け付けない", () => {
    const frag = Buffer.concat([goproLike(), box("moof", Buffer.alloc(8))]);
    expect(() => stripMp4Metadata(frag)).toThrow(Mp4Error);
    const broken = goproLike();
    broken.writeUInt32BE(0xfffffff, broken.indexOf("moov") - 4);
    expect(() => stripMp4Metadata(broken)).toThrow(Mp4Error);
    expect(() => stripMp4Metadata(Buffer.from("not a video at all"))).toThrow(Mp4Error);
  });
});

describe("M2：一時置き場を使い潰させない", () => {
  it(`投稿していない添付が ${MAX_STAGED} 件あると、次は上げられない`, async () => {
    const a = await makeUser(d);
    for (let i = 0; i < MAX_STAGED; i++) await storeFile(`staging/${a.user.id}/${randomUUID()}.pdf`, Buffer.from("%PDF-"), "application/pdf");
    await expect(authorizeStagingUpload(d, a.viewer, `staging/${a.user.id}/${randomUUID()}.pdf`)).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("低リスクの指摘", () => {
  const inDays = (n: number) => toJstLocal(new Date(Date.now() + n * 86400_000));
  const ev = (groupId = "") => ({ title: "会", description: "", location: "", startsAt: inDays(2), endsAt: "", groupId });

  it("L1：出欠の値に constructor などを渡しても、ふつうの入力エラーになる", async () => {
    const a = await makeUser(d);
    const { id } = await createEvent(d, a.viewer, ev());
    for (const s of ["constructor", "toString", "__proto__"]) await expect(setRsvp(d, a.viewer, id, s)).rejects.toMatchObject({ code: "invalid" });
  });

  it("L2：大文字の会員 ID でも、自分とのやりとりは開けない。相手とのやりとりは同じものになる", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    expect(await openConversation(d, a.viewer, a.user.id.toUpperCase())).toBeNull();
    await expect(sendMessage(d, a.viewer, a.user.id.toUpperCase(), "x")).rejects.toMatchObject({ code: "not_found" });
    await sendMessage(d, a.viewer, b.user.id.toUpperCase(), "大文字で");
    expect((await openConversation(d, b.viewer, a.user.id))!.messages.map((m) => m.body)).toEqual(["大文字で"]);
  });

  it("L3：管理者でも、入っていないグループのイベントは非表示にできない（存在も明かさない）", async () => {
    const owner = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { id: groupId } = await createGroup(d, owner.viewer, { name: `g-${randomUUID()}`, description: "", joinPolicy: "open" });
    const { id } = await createEvent(d, owner.viewer, ev(groupId));
    await expect(setEventHidden(d, admin.viewer, id, true, "理由")).rejects.toMatchObject({ code: "not_found" });
  });

  it("L4：グループを抜けた人は、そのグループのイベントの参加者に出ない", async () => {
    const owner = await makeUser(d);
    const leaver = await makeUser(d);
    const { id: groupId } = await createGroup(d, owner.viewer, { name: `g-${randomUUID()}`, description: "", joinPolicy: "open" });
    await joinGroup(d, leaver.viewer, groupId);
    const { id } = await createEvent(d, owner.viewer, ev(groupId));
    await setRsvp(d, leaver.viewer, id, "going");
    expect((await getEvent(d, owner.viewer, id))!.going).toBe(2);
    await leaveGroup(d, leaver.viewer, groupId);
    const e = await getEvent(d, owner.viewer, id);
    expect(e!.going).toBe(1);
    expect(e!.attendees.map((x) => x.id)).not.toContain(leaver.user.id);
  });

  it("L5：ファイル名から表示の向きを変える文字を除く", () => {
    expect(cleanFileName("invoice‮fdp.exe", "pdf")).toBe("invoicefdp.pdf");
  });

  it("L6：検索は 1 分に 30 回まで", async () => {
    const a = await makeUser(d);
    for (let i = 0; i < 30; i++) await listFeed(d, a.viewer, { q: `q${i}` });
    await expect(listFeed(d, a.viewer, { q: "もう一回" })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

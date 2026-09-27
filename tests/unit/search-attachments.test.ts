import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { media } from "@/server/db/schema";
import { mentionToken } from "@/lib/richtext";
import { authorizeStagingUpload, claimAttachment, cleanFileName, stripMp4Metadata } from "@/server/services/attachments";
import { mediaForViewer } from "@/server/services/media";
import { createPost, listFeed } from "@/server/services/posts";
import { readStoredFile, storeFile } from "@/server/services/storage";
import { befriend, db, makeUser, rawPost } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const found = async (viewer: Awaited<ReturnType<typeof makeUser>>["viewer"], q: string) => (await listFeed(d, viewer, { q })).posts.map((p) => p.id);

describe("投稿の全文検索（F-08）", () => {
  it("ことばを含む投稿を探す。空白で区切るとすべてを含むものだけ。全角・半角の違いは吸収する", async () => {
    const a = await makeUser(d);
    const tag = randomUUID().slice(0, 8);
    const both = await rawPost(d, a.user.id, { body: `${tag} 花見の写真 ＡＢＣ` });
    const one = await rawPost(d, a.user.id, { body: `${tag} 紅葉の写真` });
    expect(await found(a.viewer, `${tag} 写真`)).toEqual(expect.arrayContaining([both.id, one.id]));
    expect(await found(a.viewer, `${tag} 花見`)).toEqual([both.id]);
    expect(await found(a.viewer, `${tag}　abc`)).toEqual([both.id]);
  });

  it("% や _ は文字として探す（全件に当たらない）", async () => {
    const a = await makeUser(d);
    const tag = randomUUID().slice(0, 8);
    const pct = await rawPost(d, a.user.id, { body: `${tag} 達成率100%` });
    await rawPost(d, a.user.id, { body: `${tag} 普通の投稿` });
    expect(await found(a.viewer, `${tag} %`)).toEqual([pct.id]);
    expect(await found(a.viewer, `${tag} _`)).toEqual([]);
  });

  it("見えない投稿（友達のみ・ブロック相手）は検索にも出ない", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, author.user.id, friend.user.id);
    const tag = randomUUID().slice(0, 8);
    const secret = await rawPost(d, author.user.id, { body: `${tag} ないしょ`, visibility: "friends" });
    expect(await found(friend.viewer, tag)).toEqual([secret.id]);
    expect(await found(stranger.viewer, tag)).toEqual([]);
  });

  it("メンションの記法に残った名前やIDでは探せない（いま見えない相手の昔の名前で探させない）", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const tag = randomUUID().slice(0, 8);
    await rawPost(d, a.user.id, { body: `${tag} ${mentionToken("旧姓ヤマダ", b.user.id)} さんと` });
    expect(await found(a.viewer, "旧姓ヤマダ")).toEqual([]);
    expect(await found(a.viewer, b.user.id.slice(0, 8))).toEqual([]);
    expect(await found(a.viewer, `${tag} さんと`)).toHaveLength(1);
  });
});

/** ブラウザが一時置き場に上げたのと同じ状態を作る */
async function stage(ownerId: string, ext: string, data: Buffer) {
  const key = `staging/${ownerId}/${randomUUID()}.${ext}`;
  await storeFile(key, data, "application/octet-stream");
  return key;
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");
function box(type: string, payload: Buffer) {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4, "latin1");
  payload.copy(b, 8);
  return b;
}
const MP4 = Buffer.concat([
  box("ftyp", Buffer.from("isom\0\0\0\0isommp41", "latin1")),
  box("moov", Buffer.concat([box("mvhd", Buffer.alloc(20)), box("udta", box("©xyz", Buffer.from("+35.6812+139.7671/"))), box("trak", box("meta", Buffer.from("com.apple.quicktime.location.ISO6709 +35.68")))])),
  box("mdat", Buffer.from("videodata")),
]);

describe("動画・ファイルの添付（F-13）", () => {
  it("自分の一時置き場の、許した種類にだけ上げられる", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await expect(authorizeStagingUpload(d, a.viewer, `staging/${a.user.id}/${randomUUID()}.pdf`)).resolves.toMatchObject({ label: "PDF" });
    await expect(authorizeStagingUpload(d, a.viewer, `staging/${b.user.id}/${randomUUID()}.pdf`)).rejects.toMatchObject({ code: "invalid" });
    await expect(authorizeStagingUpload(d, a.viewer, `staging/${a.user.id}/${randomUUID()}.html`)).rejects.toMatchObject({ code: "invalid" });
    await expect(authorizeStagingUpload(d, a.viewer, `staging/${a.user.id}/../${randomUUID()}.pdf`)).rejects.toMatchObject({ code: "invalid" });
    const pending = await makeUser(d, { status: "pending" });
    await expect(authorizeStagingUpload(d, pending.viewer, `staging/${pending.user.id}/${randomUUID()}.pdf`)).rejects.toBeTruthy();
    await expect(authorizeStagingUpload(d, null, `staging/${a.user.id}/${randomUUID()}.pdf`)).rejects.toBeTruthy();
  });

  it("他人の一時置き場のファイルは、キーを知っていても自分の投稿に付けられない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const key = await stage(b.user.id, "pdf", PDF);
    await expect(claimAttachment(a.viewer, { key, name: "x.pdf" })).rejects.toMatchObject({ code: "invalid" });
    expect(await readStoredFile(key)).not.toBeNull(); // 他人のものは消さない
  });

  it("中身が拡張子と違うもの（PDF と名乗る HTML など）は受け付けない", async () => {
    const a = await makeUser(d);
    const key = await stage(a.user.id, "pdf", Buffer.from("<html><script>alert(1)</script></html>"));
    await expect(claimAttachment(a.viewer, { key, name: "x.pdf" })).rejects.toMatchObject({ code: "invalid" });
    expect(await readStoredFile(key)).toBeNull(); // 一時置き場からは消える
    const docx = await stage(a.user.id, "docx", PDF);
    await expect(claimAttachment(a.viewer, { key: docx, name: "x.docx" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("動画の位置情報などのメタデータを消す（大きさと映像データの位置は変えない）", () => {
    expect(MP4.includes("+35.6812")).toBe(true);
    const out = stripMp4Metadata(MP4);
    expect(out.length).toBe(MP4.length);
    expect(out.toString("latin1")).not.toMatch(/udta|meta|\+35\.68|ISO6709/);
    expect(out.indexOf("mdat")).toBe(MP4.indexOf("mdat"));
    expect(out.toString("latin1", 4, 8)).toBe("ftyp");
    // 壊れた箱の大きさでも止まる（無限ループや範囲外の書き込みをしない）
    const broken = Buffer.from(MP4);
    broken.writeUInt32BE(0xffffff, 0);
    expect(() => stripMp4Metadata(broken)).not.toThrow();
  });

  it("ファイル名はパスや危ない文字を除き、拡張子は中身の種類に合わせる", () => {
    expect(cleanFileName("../../etc/passwd.pdf", "pdf")).toBe("passwd.pdf");
    expect(cleanFileName('C:\\x\\見積"<b>.MOV', "mp4")).toBe("見積b.mp4");
    expect(cleanFileName("", "pdf")).toBe("file.pdf");
  });

  it("投稿に付けた動画・ファイルは、投稿が見える人にだけ配信する。動画はメタデータを消して保存する", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, author.user.id, friend.user.id);
    const pdf = await stage(author.user.id, "pdf", PDF);
    const mov = await stage(author.user.id, "mov", MP4);
    const { id } = await createPost(d, author.viewer, { body: "資料と動画", visibility: "friends", attachments: [{ key: pdf, name: "議事録.pdf" }, { key: mov, name: "花火.MOV" }] });
    const rows = await d.select().from(media).where(eq(media.postId, id));
    expect(rows.map((r) => [r.mime, r.fileName])).toEqual(
      expect.arrayContaining([
        ["application/pdf", "議事録.pdf"],
        ["video/mp4", "花火.mp4"],
      ]),
    );
    const video = rows.find((r) => r.mime === "video/mp4")!;
    const stored = await readStoredFile(video.storageKey);
    expect(Buffer.from(stored!.body as Buffer).includes("+35.6812")).toBe(false);
    expect(await readStoredFile(pdf)).toBeNull(); // 一時置き場からは移した

    expect(await mediaForViewer(d, friend.viewer, video.id)).toMatchObject({ mime: "video/mp4", fileName: "花火.mp4" });
    expect(await mediaForViewer(d, stranger.viewer, video.id)).toBeNull();
    const [post] = (await listFeed(d, friend.viewer, { authorId: author.user.id })).posts;
    expect(post!.media.map((m) => m.fileName)).toEqual(["議事録.pdf", "花火.mp4"]);
  });

  it("動画・ファイルは 2 件まで。範囲指定で一部だけ読める", async () => {
    const a = await makeUser(d);
    const keys = await Promise.all([1, 2, 3].map(() => stage(a.user.id, "pdf", PDF)));
    await expect(createPost(d, a.viewer, { body: "x", visibility: "members", attachments: keys.map((key) => ({ key, name: "a.pdf" })) })).rejects.toMatchObject({ code: "invalid" });
    const r = await readStoredFile(keys[0]!, { start: 1, end: 3 });
    expect(Buffer.from(r!.body as Buffer).toString()).toBe("PDF");
    expect(r!.range).toEqual({ start: 1, end: 3 });
  });
});

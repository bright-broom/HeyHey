import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@/server/db/client";
import { media, users } from "@/server/db/schema";
import { toViewer } from "@/server/lib/viewer";
import { mediaForViewer } from "@/server/services/media";
import { addComment, createPost, getPost, listFeed, toggleReaction } from "@/server/services/posts";
import { createReport } from "@/server/services/reports";
import { searchMembers, getProfile } from "@/server/services/members";
import { befriend, db, makeUser, rawPost } from "./helpers";

/**
 * 公開範囲（要件 5 章）の検証。
 * 「見えてはいけない人に見えない」ことを、一覧・詳細・画像・コメント・リアクション・通報の
 * すべての入口で確認する。1 か所でも漏れると許可制の意味がなくなるため、ここを最重要テストとする。
 */
let d: Db;
beforeAll(async () => {
  d = await db();
});

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: "#39f" } }).png().toBuffer();

describe("公開範囲：全会員／友達のみ", () => {
  it("全会員向けの投稿は承認済み会員なら誰でも見える", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const p = await rawPost(d, a.user.id, { visibility: "members" });
    expect(await getPost(d, b.viewer, p.id)).not.toBeNull();
    expect((await listFeed(d, b.viewer)).posts.map((x) => x.id)).toContain(p.id);
  });

  it("友達のみの投稿は、友達と本人にだけ見える", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, friend.user.id, author.user.id); // 申請の向きが逆でも友達として扱う
    const p = await rawPost(d, author.user.id, { visibility: "friends" });
    expect(await getPost(d, author.viewer, p.id)).not.toBeNull();
    expect(await getPost(d, friend.viewer, p.id)).not.toBeNull();
    expect(await getPost(d, stranger.viewer, p.id)).toBeNull();
    expect((await listFeed(d, stranger.viewer)).posts.map((x) => x.id)).not.toContain(p.id);
    expect((await listFeed(d, stranger.viewer, { authorId: author.user.id })).posts).toHaveLength(0);
  });

  it("管理者でも、通報されていない友達のみ投稿は見えない", async () => {
    const author = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const p = await rawPost(d, author.user.id, { visibility: "friends" });
    expect(await getPost(d, admin.viewer, p.id)).toBeNull();
  });

  it("申請中・未確認・停止中・規約未同意の人は、フィードも投稿も取得できない", async () => {
    const author = await makeUser(d);
    const p = await rawPost(d, author.user.id);
    for (const o of [{ status: "pending" as const }, { status: "unverified" as const }, { status: "suspended" as const }, { status: "active" as const, terms: false }]) {
      const v = await makeUser(d, o);
      await expect(listFeed(d, v.viewer)).rejects.toMatchObject({ code: "forbidden" });
      await expect(getPost(d, v.viewer, p.id)).rejects.toMatchObject({ code: "forbidden" });
      await expect(searchMembers(d, v.viewer)).rejects.toMatchObject({ code: "forbidden" });
    }
  });
});

describe("非表示・削除・投稿者の状態", () => {
  it("非表示にされた投稿は本人にだけ「非表示中」として見える", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const p = await rawPost(d, a.user.id, { hiddenAt: new Date(), hiddenReason: "moderation" });
    expect(await getPost(d, b.viewer, p.id)).toBeNull();
    const own = await getPost(d, a.viewer, p.id);
    expect(own?.hidden).toBe(true);
  });

  it("削除された投稿は本人にも見えない", async () => {
    const a = await makeUser(d);
    const p = await rawPost(d, a.user.id, { deletedAt: new Date() });
    expect(await getPost(d, a.viewer, p.id)).toBeNull();
  });

  it("停止中の会員の投稿は隠れ、退会（匿名化）した会員の投稿は匿名で残る", async () => {
    const reader = await makeUser(d);
    const s = await makeUser(d);
    const w = await makeUser(d);
    const ps = await rawPost(d, s.user.id);
    const pw = await rawPost(d, w.user.id);
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, s.user.id));
    await d.update(users).set({ status: "withdrawn", displayName: "退会したメンバー" }).where(eq(users.id, w.user.id));
    expect(await getPost(d, reader.viewer, ps.id)).toBeNull();
    const anon = await getPost(d, reader.viewer, pw.id);
    expect(anon?.author).toEqual({ id: null, displayName: "退会したメンバー", avatarMediaId: null });
  });

  it("停止・申請中の会員のプロフィールは他の会員から見えない", async () => {
    const reader = await makeUser(d);
    const s = await makeUser(d, { status: "suspended" });
    const p = await makeUser(d, { status: "pending" });
    expect(await getProfile(d, reader.viewer, s.user.id)).toBeNull();
    expect(await getProfile(d, reader.viewer, p.user.id)).toBeNull();
    const list = await searchMembers(d, reader.viewer);
    expect(list.map((x) => x.id)).not.toContain(s.user.id);
    expect(list.map((x) => x.id)).not.toContain(p.user.id);
  });
});

describe("見えない投稿には、どの入口からも触れない", () => {
  it("コメント・リアクション・通報はすべて not_found（存在自体を明かさない）", async () => {
    const author = await makeUser(d);
    const stranger = await makeUser(d);
    const p = await rawPost(d, author.user.id, { visibility: "friends" });
    await expect(addComment(d, stranger.viewer, { postId: p.id, body: "hi" })).rejects.toMatchObject({ code: "not_found" });
    await expect(toggleReaction(d, stranger.viewer, { postId: p.id }, "like")).rejects.toMatchObject({ code: "not_found" });
    await expect(createReport(d, stranger.viewer, { targetType: "post", targetId: p.id, reason: "spam" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("友達のみ投稿へのコメントは、友達でない人のフィードには出てこない", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, author.user.id, friend.user.id);
    const p = await rawPost(d, author.user.id, { visibility: "friends" });
    await addComment(d, friend.viewer, { postId: p.id, body: "内緒の話" });
    const feed = await listFeed(d, stranger.viewer);
    expect(JSON.stringify(feed)).not.toContain("内緒の話");
  });
});

describe("画像の配信", () => {
  it("未ログイン・見えない人には null、見える人にはファイルを返す", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, author.user.id, friend.user.id);
    const { id } = await createPost(d, author.viewer, { body: "", visibility: "friends", images: [await png()] });
    const [m] = await d.select().from(media).where(eq(media.postId, id));
    expect(await mediaForViewer(d, null, m!.id)).toBeNull();
    expect(await mediaForViewer(d, stranger.viewer, m!.id)).toBeNull();
    expect(await mediaForViewer(d, friend.viewer, m!.id)).not.toBeNull();
    const pending = await makeUser(d, { status: "pending" });
    expect(await mediaForViewer(d, pending.viewer, m!.id)).toBeNull();
  });

  it("管理者は通報された投稿に限り、友達のみの画像も確認できる", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    await befriend(d, author.user.id, friend.user.id);
    const { id } = await createPost(d, author.viewer, { body: "x", visibility: "friends", images: [await png()] });
    const [m] = await d.select().from(media).where(eq(media.postId, id));
    expect(await mediaForViewer(d, admin.viewer, m!.id)).toBeNull();
    await createReport(d, friend.viewer, { targetType: "post", targetId: id, reason: "privacy" });
    expect(await mediaForViewer(d, admin.viewer, m!.id)).not.toBeNull();
  });

  it("状態が変わったら次のリクエストから見えなくなる（停止は即時反映）", async () => {
    const author = await makeUser(d);
    const reader = await makeUser(d);
    const { id } = await createPost(d, author.viewer, { body: "x", visibility: "members", images: [await png()] });
    const [m] = await d.select().from(media).where(eq(media.postId, id));
    expect(await mediaForViewer(d, reader.viewer, m!.id)).not.toBeNull();
    const [u] = await d.update(users).set({ status: "suspended" }).where(eq(users.id, reader.user.id)).returning();
    expect(await mediaForViewer(d, toViewer(u!), m!.id)).toBeNull();
  });
});

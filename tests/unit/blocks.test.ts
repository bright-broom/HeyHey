import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { friendships, media, notifications, profiles } from "@/server/db/schema";
import { blockUser, listBlocksAndMutes, muteUser, unblockUser, unmuteUser } from "@/server/services/blocks";
import { requestFriend } from "@/server/services/friends";
import { mediaForViewer } from "@/server/services/media";
import { getProfile, searchMembers } from "@/server/services/members";
import { listNotifications, notify } from "@/server/services/notifications";
import { addComment, getPost, listFeed, toggleReaction } from "@/server/services/posts";
import { createReport, getCase } from "@/server/services/reports";
import { befriend, db, makeUser, rawPost } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const feedBodies = async (v: Parameters<typeof listFeed>[1], authorId?: string) =>
  (await listFeed(d, v, authorId ? { authorId } : {})).posts.map((p) => p.body);

describe("ブロック（双方向）", () => {
  it("お互いの投稿・コメントが見えなくなる。第三者の投稿の下でも同じ", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const c = await makeUser(d);
    const aPost = await rawPost(d, a.user.id, { body: `A の投稿 ${a.user.id}` });
    const bPost = await rawPost(d, b.user.id, { body: `B の投稿 ${b.user.id}` });
    const cPost = await rawPost(d, c.user.id, { body: `C の投稿 ${c.user.id}` });
    await addComment(d, b.viewer, { postId: cPost.id, body: "B のコメント" });
    await addComment(d, a.viewer, { postId: cPost.id, body: "A のコメント" });

    await blockUser(d, a.viewer, b.user.id);

    expect(await getPost(d, a.viewer, bPost.id)).toBeNull();
    expect(await getPost(d, b.viewer, aPost.id)).toBeNull();
    expect(await feedBodies(a.viewer)).not.toContain(bPost.body);
    expect(await feedBodies(b.viewer)).not.toContain(aPost.body);
    expect((await getPost(d, a.viewer, cPost.id))!.comments.map((x) => x.body)).toEqual(["A のコメント"]);
    expect((await getPost(d, b.viewer, cPost.id))!.comments.map((x) => x.body)).toEqual(["B のコメント"]);
    // 第三者には、これまでどおり両方見える
    expect((await getPost(d, c.viewer, cPost.id))!.comments).toHaveLength(2);
  });

  it("ブロックされた側からは、相手が存在しないように見える。ブロックした側は解除のためにプロフィールを開ける", async () => {
    const a = await makeUser(d, { displayName: `ブロッカー${Date.now()}` });
    const b = await makeUser(d, { displayName: `ブロック対象${Date.now()}` });
    await blockUser(d, a.viewer, b.user.id);
    expect(await getProfile(d, b.viewer, a.user.id)).toBeNull();
    expect(await getProfile(d, a.viewer, b.user.id)).toMatchObject({ blocking: true });
    expect((await searchMembers(d, b.viewer, a.user.displayName)).map((m) => m.id)).not.toContain(a.user.id);
    expect((await searchMembers(d, a.viewer, b.user.displayName)).map((m) => m.id)).not.toContain(b.user.id);
    // ブロックされた側がブロックし返そうとしても、相手は「見つからない」（ブロックの有無を明かさない）
    await expect(blockUser(d, b.viewer, a.user.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("友達は解除され、申請・コメント・リアクション・通知が届かない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await befriend(d, a.user.id, b.user.id);
    const aPost = await rawPost(d, a.user.id, { visibility: "friends" });
    await blockUser(d, a.viewer, b.user.id);

    expect(await d.select().from(friendships).where(eq(friendships.requesterId, a.user.id))).toHaveLength(0);
    await expect(requestFriend(d, b.viewer, a.user.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(requestFriend(d, a.viewer, b.user.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(addComment(d, b.viewer, { postId: aPost.id, body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(toggleReaction(d, b.viewer, { postId: aPost.id }, "like")).rejects.toMatchObject({ code: "not_found" });

    await notify(d, { userId: a.user.id, type: "comment", actorId: b.user.id });
    await notify(d, { userId: b.user.id, type: "comment", actorId: a.user.id });
    expect(await d.select().from(notifications).where(and(eq(notifications.userId, a.user.id), eq(notifications.actorId, b.user.id)))).toHaveLength(0);
    expect(await d.select().from(notifications).where(and(eq(notifications.userId, b.user.id), eq(notifications.actorId, a.user.id)))).toHaveLength(0);
  });

  it("ブロック前に届いていた通知も、お互いの一覧から消える", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await notify(d, { userId: a.user.id, type: "friend_request", actorId: b.user.id });
    await notify(d, { userId: b.user.id, type: "friend_request", actorId: a.user.id });
    await blockUser(d, a.viewer, b.user.id);
    expect(await listNotifications(d, a.viewer)).toHaveLength(0);
    expect(await listNotifications(d, b.viewer)).toHaveLength(0);
  });

  it("プロフィール写真も、ブロックした相手には配信しない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const [m] = await d.insert(media).values({ ownerId: a.user.id, kind: "avatar", storageKey: `${crypto.randomUUID()}.webp`, mime: "image/webp", width: 1, height: 1, bytes: 1 }).returning();
    await d.update(profiles).set({ avatarMediaId: m!.id }).where(eq(profiles.userId, a.user.id));
    expect(await mediaForViewer(d, b.viewer, m!.id)).not.toBeNull();
    await blockUser(d, a.viewer, b.user.id);
    expect(await mediaForViewer(d, b.viewer, m!.id)).toBeNull();
    expect(await mediaForViewer(d, a.viewer, m!.id)).not.toBeNull();
  });

  it("解除すると投稿は見えるようになるが、友達関係は戻らない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await befriend(d, a.user.id, b.user.id);
    const bPost = await rawPost(d, b.user.id);
    await blockUser(d, a.viewer, b.user.id);
    expect((await listBlocksAndMutes(d, a.viewer)).blocked.map((x) => x.id)).toEqual([b.user.id]);
    await unblockUser(d, a.viewer, b.user.id);
    expect(await getPost(d, a.viewer, bPost.id)).not.toBeNull();
    expect(await d.select().from(friendships).where(eq(friendships.requesterId, a.user.id))).toHaveLength(0);
  });

  it("管理者の通報対応は、管理者個人のブロックに左右されない", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const author = await makeUser(d);
    const reporter = await makeUser(d);
    const post = await rawPost(d, author.user.id, { body: "通報される投稿" });
    await blockUser(d, admin.viewer, author.user.id);
    await blockUser(d, admin.viewer, reporter.user.id);
    await createReport(d, reporter.viewer, { targetType: "post", targetId: post.id, reason: "spam" });
    const c = await getCase(d, admin.viewer, "post", post.id);
    expect(JSON.stringify(c)).toContain("通報される投稿");
    const mine = await listNotifications(d, admin.viewer);
    expect(mine.some((n) => n.type === "report_submitted")).toBe(true);
  });
});

describe("ミュート（一方向・相手に伝わらない）", () => {
  it("ホームのフィードから外れ、通知も止まる。プロフィールでは見える。相手側は何も変わらない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const bPost = await rawPost(d, b.user.id, { body: `ミュートされる投稿 ${b.user.id}` });
    const aPost = await rawPost(d, a.user.id, { body: `ミュートした人の投稿 ${a.user.id}` });
    await muteUser(d, a.viewer, b.user.id);

    expect(await feedBodies(a.viewer)).not.toContain(bPost.body);
    expect(await feedBodies(a.viewer, b.user.id)).toContain(bPost.body);
    expect(await getPost(d, a.viewer, bPost.id)).not.toBeNull();
    expect(await feedBodies(b.viewer)).toContain(aPost.body);

    await addComment(d, b.viewer, { postId: aPost.id, body: "ミュート中のコメント" });
    expect(await listNotifications(d, a.viewer)).toHaveLength(0);
    expect(await getProfile(d, b.viewer, a.user.id)).toMatchObject({ blocking: false, muting: false });

    await unmuteUser(d, a.viewer, b.user.id);
    expect(await feedBodies(a.viewer)).toContain(bPost.body);
  });

  it("自分自身・存在しない人はブロック・ミュートできない", async () => {
    const a = await makeUser(d);
    await expect(blockUser(d, a.viewer, a.user.id)).rejects.toMatchObject({ code: "invalid" });
    await expect(muteUser(d, a.viewer, crypto.randomUUID())).rejects.toMatchObject({ code: "not_found" });
    const pending = await makeUser(d, { status: "pending" });
    await expect(blockUser(d, pending.viewer, a.user.id)).rejects.toMatchObject({ code: "forbidden" });
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@/server/db/client";
import { media, notifications, users } from "@/server/db/schema";
import { safeLocalPath } from "@/server/lib/redirect";
import { setInviteQuota, suspendUser } from "@/server/services/admin";
import { requestFriend, respondFriend, removeFriend } from "@/server/services/friends";
import { createInvitation, revokeInvitation } from "@/server/services/invites";
import { listNotifications, unreadCount } from "@/server/services/notifications";
import { addComment, createPost, deletePost, toggleReaction } from "@/server/services/posts";
import { createReport, resolveCase } from "@/server/services/reports";
import { befriend, db, makeUser, rawPost } from "./helpers";

/** 独立したセキュリティレビューの指摘ごとの回帰テスト */
let d: Db;
beforeAll(async () => {
  d = await db();
});

describe("ログイン後の遷移先（オープンリダイレクト）", () => {
  it("サイト内のパスだけを通し、外部に飛ぶものは拒否する", () => {
    expect(safeLocalPath("/posts/abc?x=1")).toBe("/posts/abc?x=1");
    for (const bad of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/%09/evil.example".replace("%09", "\t"), "https://evil.example", "javascript:alert(1)", "/\n/evil.example", ""]) {
      expect(safeLocalPath(bad)).toBeNull();
    }
  });
});

describe("通報処理でも権限の境界を守る", () => {
  it("自分の投稿への通報は自分で処分できない（ほかの管理者に任せる）。ほかの管理者の投稿は処分できる", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const admin2 = await makeUser(d, { role: "admin" });
    const reporter = await makeUser(d);
    const myPost = await rawPost(d, admin.user.id);
    const adminPost = await rawPost(d, admin2.user.id);
    await createReport(d, reporter.viewer, { targetType: "post", targetId: myPost.id, reason: "spam" });
    await createReport(d, reporter.viewer, { targetType: "post", targetId: adminPost.id, reason: "spam" });
    await expect(resolveCase(d, admin.viewer, { targetType: "post", targetId: myPost.id, resolution: "hidden" })).rejects.toMatchObject({ code: "forbidden" });
    // 「問題なし」は誰に対してでも可能
    await resolveCase(d, admin.viewer, { targetType: "post", targetId: myPost.id, resolution: "dismissed" });
    await resolveCase(d, admin.viewer, { targetType: "post", targetId: adminPost.id, resolution: "warned" });
  });
});

describe("管理操作の取りこぼし", () => {
  it("他人の招待リンクを取り消せるのは管理者だけ（管理者どうしも可）", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const admin2 = await makeUser(d, { role: "admin" });
    const member = await makeUser(d);
    const { invitation } = await createInvitation(d, admin2.viewer, {});
    await expect(revokeInvitation(d, member.viewer, invitation.id)).rejects.toMatchObject({ code: "forbidden" });
    await revokeInvitation(d, admin.viewer, invitation.id);
  });

  it("招待枠は一般会員にだけ設定できる", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const admin2 = await makeUser(d, { role: "admin" });
    await expect(setInviteQuota(d, admin.viewer, admin2.user.id, 0)).rejects.toMatchObject({ code: "invalid" });
  });

  it("不正な ID は 500 ではなく not_found / invalid になる", async () => {
    const admin = await makeUser(d, { role: "admin" });
    await expect(suspendUser(d, admin.viewer, "not-a-uuid", "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeInvitation(d, admin.viewer, "../../etc")).rejects.toMatchObject({ code: "not_found" });
    await expect(createInvitation(d, admin.viewer, { maxUses: 9999 })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("通知からの漏えい", () => {
  it("友達を解除されたら、友達のみ投稿への返信通知は見えなくなる", async () => {
    const author = await makeUser(d);
    const friend = await makeUser(d);
    const replier = await makeUser(d);
    await befriend(d, author.user.id, friend.user.id);
    await befriend(d, author.user.id, replier.user.id);
    const p = await rawPost(d, author.user.id, { visibility: "friends" });
    const { id } = await addComment(d, friend.viewer, { postId: p.id, body: "コメント" });
    await addComment(d, replier.viewer, { postId: p.id, body: "返信", parentId: id });
    expect((await listNotifications(d, friend.viewer)).some((n) => n.type === "reply")).toBe(true);
    await removeFriend(d, author.viewer, friend.user.id);
    expect((await listNotifications(d, friend.viewer)).some((n) => n.type === "reply")).toBe(false);
    expect(await unreadCount(d, friend.viewer)).toBe(0);
  });

  it("リアクションを付け外ししても、通知は 1 件だけ", async () => {
    const author = await makeUser(d);
    const fan = await makeUser(d);
    const p = await rawPost(d, author.user.id);
    for (let i = 0; i < 6; i++) await toggleReaction(d, fan.viewer, { postId: p.id }, "like");
    const n = await d.select().from(notifications).where(and(eq(notifications.userId, author.user.id), eq(notifications.type, "reaction")));
    expect(n).toHaveLength(1);
  });
});

describe("友達申請と状態", () => {
  it("停止中の会員からの友達申請は承認できない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await requestFriend(d, a.viewer, b.user.id);
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, a.user.id));
    await expect(respondFriend(d, b.viewer, a.user.id, true)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("画像の後始末", () => {
  it("投稿を削除すると画像ファイルも消える", async () => {
    const a = await makeUser(d);
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).png().toBuffer();
    const { id } = await createPost(d, a.viewer, { body: "x", visibility: "members", images: [png] });
    const [m] = await d.select().from(media).where(eq(media.postId, id));
    const file = path.resolve(process.env.UPLOAD_DIR!, m!.storageKey);
    expect(fs.existsSync(file)).toBe(true);
    await deletePost(d, a.viewer, id);
    expect(fs.existsSync(file)).toBe(false);
    expect(await d.select().from(media).where(eq(media.postId, id))).toHaveLength(0);
  });
});

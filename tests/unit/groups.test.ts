import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { Db } from "@/server/db/client";
import { groupMembers, media, notifications, posts, users } from "@/server/db/schema";
import { mentionToken } from "@/lib/richtext";
import { blockUser } from "@/server/services/blocks";
import {
  createGroup,
  getGroup,
  joinGroup,
  leaveGroup,
  listGroupMembers,
  listGroups,
  removeMember,
  respondJoinRequest,
  setGroupArchived,
  transferGroupOwnership,
  unbanMember,
  updateGroup,
  assignGroupOwnerByAdmin,
} from "@/server/services/groups";
import { mediaForViewer } from "@/server/services/media";
import { withdraw } from "@/server/services/members";
import { addComment, createPost, deletePost, getPost, getPostForEdit, listFeed, toggleReaction, updatePost } from "@/server/services/posts";
import { db, makeUser, PASSWORD } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

type U = Awaited<ReturnType<typeof makeUser>>;
const newGroup = (owner: U, joinPolicy: "open" | "approval" = "open", name = `グループ${Date.now()}${Math.random()}`) =>
  createGroup(d, owner.viewer, { name, description: "説明", joinPolicy });
const homeIds = async (u: U) => (await listFeed(d, u.viewer)).posts.map((p) => p.id);

describe("グループの投稿は、アクティブなメンバーにだけ見える", () => {
  it("詳細・ホーム・グループのフィード・画像・コメント・リアクションのどこからも、メンバー以外には見えない", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const outsider = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#123456" } }).jpeg().toBuffer();
    const { id } = await createPost(d, owner.viewer, { body: "グループ内の話", visibility: "members", groupId: gid, images: [img] });
    const [m] = await d.select().from(media).where(eq(media.postId, id));

    expect(await getPost(d, member.viewer, id)).toMatchObject({ group: { id: gid } });
    expect(await homeIds(member)).toContain(id);
    expect((await listFeed(d, member.viewer, { groupId: gid })).posts.map((p) => p.id)).toEqual([id]);
    expect(await mediaForViewer(d, member.viewer, m!.id)).not.toBeNull();

    expect(await getPost(d, outsider.viewer, id)).toBeNull();
    expect(await homeIds(outsider)).not.toContain(id);
    expect((await listFeed(d, outsider.viewer, { groupId: gid })).posts).toHaveLength(0);
    expect(await mediaForViewer(d, outsider.viewer, m!.id)).toBeNull();
    await expect(addComment(d, outsider.viewer, { postId: id, body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(toggleReaction(d, outsider.viewer, { postId: id }, "like")).rejects.toMatchObject({ code: "not_found" });
  });

  it("メンバー以外へのメンションは通知しない。ハッシュタグの一覧にも出ない", async () => {
    const owner = await makeUser(d);
    const outsider = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    const tag = `グループタグ${Date.now()}`;
    await createPost(d, owner.viewer, { body: `${mentionToken("外の人", outsider.user.id)} #${tag}`, visibility: "members", groupId: gid });
    expect(await d.select().from(notifications).where(and(eq(notifications.userId, outsider.user.id), eq(notifications.type, "mention")))).toHaveLength(0);
    expect((await listFeed(d, outsider.viewer, { tag: tag.toLowerCase() })).posts).toHaveLength(0);
    expect((await listFeed(d, owner.viewer, { tag: tag.toLowerCase() })).posts).toHaveLength(1);
  });

  it("メンバー以外・承認待ちの人は、グループに投稿できない。公開範囲は常にグループのメンバー", async () => {
    const owner = await makeUser(d);
    const pending = await makeUser(d);
    const outsider = await makeUser(d);
    const { id: gid } = await newGroup(owner, "approval");
    await joinGroup(d, pending.viewer, gid);
    await expect(createPost(d, outsider.viewer, { body: "x", visibility: "members", groupId: gid })).rejects.toMatchObject({ code: "not_found" });
    await expect(createPost(d, pending.viewer, { body: "x", visibility: "members", groupId: gid })).rejects.toMatchObject({ code: "not_found" });
    const { id } = await createPost(d, owner.viewer, { body: "x", visibility: "friends", groupId: gid });
    const [row] = await d.select().from(posts).where(eq(posts.id, id));
    expect(row!.visibility).toBe("members");
  });

  it("外されると、自分の投稿も含めて見えず、書き込めない。参加自由でも、解除されるまで入り直せない", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    const { id: mine } = await createPost(d, member.viewer, { body: "自分の投稿", visibility: "members", groupId: gid });
    const { id: others } = await createPost(d, owner.viewer, { body: "オーナーの投稿", visibility: "members", groupId: gid });
    await removeMember(d, owner.viewer, gid, member.user.id);

    expect(await getPost(d, member.viewer, others)).toBeNull();
    // 自分の投稿を入口に、その後のやりとりを読み書きさせない
    await addComment(d, owner.viewer, { postId: mine, body: "外した後のコメント" });
    expect(await getPost(d, member.viewer, mine)).toBeNull();
    await expect(addComment(d, member.viewer, { postId: mine, body: "x" })).rejects.toMatchObject({ code: "not_found" });
    await expect(toggleReaction(d, member.viewer, { postId: mine }, "like")).rejects.toMatchObject({ code: "not_found" });
    expect(await d.select().from(notifications).where(and(eq(notifications.userId, member.user.id), eq(notifications.type, "comment")))).toHaveLength(0);
    await expect(listGroupMembers(d, member.viewer, gid)).rejects.toMatchObject({ code: "not_found" });

    await expect(joinGroup(d, member.viewer, gid)).rejects.toMatchObject({ code: "forbidden" });
    await unbanMember(d, owner.viewer, gid, member.user.id);
    expect(await joinGroup(d, member.viewer, gid)).toBe("joined");
    expect(await getPost(d, member.viewer, mine)).not.toBeNull();
  });

  it("外された人は、自分の古いグループ投稿も編集できない（削除はできる）", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const other = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    await joinGroup(d, other.viewer, gid);
    const { id: mine } = await createPost(d, member.viewer, { body: "元の本文", visibility: "members", groupId: gid });
    await removeMember(d, owner.viewer, gid, member.user.id);
    await expect(updatePost(d, member.viewer, mine, { body: `${mentionToken("x", other.user.id)} 書き換え`, visibility: "members" })).rejects.toMatchObject({ code: "not_found" });
    expect(await getPostForEdit(d, member.viewer, mine)).toBeNull();
    expect((await getPost(d, owner.viewer, mine))!.body).toBe("元の本文");
    await deletePost(d, member.viewer, mine);
    expect(await getPost(d, owner.viewer, mine)).toBeNull();
  });

  it("自分から退出した人は、また参加できる", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    await leaveGroup(d, member.viewer, gid);
    expect(await joinGroup(d, member.viewer, gid)).toBe("joined");
  });

  it("同じグループでも、ブロックし合う人の投稿とメンバー表示は見えない。停止中の人の投稿も隠れる", async () => {
    const owner = await makeUser(d);
    const a = await makeUser(d);
    const b = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, a.viewer, gid);
    await joinGroup(d, b.viewer, gid);
    const { id: bPost } = await createPost(d, b.viewer, { body: "B の投稿", visibility: "members", groupId: gid });
    await blockUser(d, a.viewer, b.user.id);
    expect(await getPost(d, a.viewer, bPost)).toBeNull();
    expect((await listGroupMembers(d, a.viewer, gid)).active.map((m) => m.id)).not.toContain(b.user.id);
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, b.user.id));
    expect(await getPost(d, owner.viewer, bPost)).toBeNull();
  });
});

describe("参加のしかた", () => {
  it("承認制：申請は管理人にだけ通知され、承認されるまで何も見えない。メンバーは承認できない", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const applicant = await makeUser(d);
    const { id: gid } = await newGroup(owner, "approval");
    await joinGroup(d, member.viewer, gid);
    await respondJoinRequest(d, owner.viewer, gid, member.user.id, true);
    const { id } = await createPost(d, owner.viewer, { body: "x", visibility: "members", groupId: gid });

    expect(await joinGroup(d, applicant.viewer, gid)).toBe("requested");
    expect(await getPost(d, applicant.viewer, id)).toBeNull();
    const notified = async (userId: string) =>
      (await d.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "group_join_request"), eq(notifications.actorId, applicant.user.id)))).length;
    expect(await notified(owner.user.id)).toBe(1);
    expect(await notified(member.user.id)).toBe(0);
    await expect(respondJoinRequest(d, applicant.viewer, gid, applicant.user.id, true)).rejects.toMatchObject({ code: "forbidden" });
    await expect(respondJoinRequest(d, member.viewer, gid, applicant.user.id, true)).rejects.toMatchObject({ code: "forbidden" });
    await respondJoinRequest(d, owner.viewer, gid, applicant.user.id, true);
    expect(await getPost(d, applicant.viewer, id)).not.toBeNull();
    expect(await d.select().from(notifications).where(and(eq(notifications.userId, applicant.user.id), eq(notifications.type, "group_join_approved")))).toHaveLength(1);
  });

  it("名前と説明は全会員に見える。承認制から参加自由にすると、待っていた申請は承認される", async () => {
    const owner = await makeUser(d);
    const other = await makeUser(d);
    const waiting = await makeUser(d);
    const name = `見える名前${Date.now()}`;
    const { id: gid } = await newGroup(owner, "approval", name);
    const listed = (await listGroups(d, other.viewer)).find((g) => g.id === gid);
    expect(listed).toMatchObject({ name, memberCount: 1, me: null });
    await joinGroup(d, waiting.viewer, gid);
    await updateGroup(d, owner.viewer, gid, { name, description: "", joinPolicy: "open" });
    expect((await getGroup(d, waiting.viewer, gid)).me).toMatchObject({ status: "active" });
  });
});

describe("グループの管理", () => {
  it("役割は管理人とメンバーの 2 つ：管理人は外せない・退出できない。外す・移すのは管理人だけ。移すと元の管理人はメンバーになる", async () => {
    const owner = await makeUser(d);
    const m1 = await makeUser(d);
    const m2 = await makeUser(d);
    const plain = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    for (const u of [m1, m2, plain]) await joinGroup(d, u.viewer, gid);

    await expect(leaveGroup(d, owner.viewer, gid)).rejects.toMatchObject({ code: "conflict" });
    await expect(removeMember(d, m1.viewer, gid, owner.user.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeMember(d, m1.viewer, gid, plain.user.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(transferGroupOwnership(d, m1.viewer, gid, m1.user.id)).rejects.toMatchObject({ code: "forbidden" });
    await removeMember(d, owner.viewer, gid, plain.user.id);

    await transferGroupOwnership(d, owner.viewer, gid, m1.user.id);
    const roles = Object.fromEntries((await d.select().from(groupMembers).where(eq(groupMembers.groupId, gid))).map((r) => [r.userId, r.role]));
    expect(roles[m1.user.id]).toBe("owner");
    expect(roles[owner.user.id]).toBe("member");
    expect(Object.values(roles).filter((r) => r === "owner")).toHaveLength(1);
    await expect(transferGroupOwnership(d, owner.viewer, gid, m2.user.id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("閉じると、メンバーにも投稿が見えず、書けない。メンバー以外にはグループごと見えない。サイトの管理者も閉じられる", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const outsider = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    const { id } = await createPost(d, owner.viewer, { body: "x", visibility: "members", groupId: gid });

    await expect(setGroupArchived(d, member.viewer, gid, true)).rejects.toMatchObject({ code: "forbidden" });
    await setGroupArchived(d, admin.viewer, gid, true);
    expect(await getPost(d, member.viewer, id)).toBeNull();
    // 閉じたグループでは、投稿者本人にも見えない
    expect(await getPost(d, owner.viewer, id)).toBeNull();
    await expect(createPost(d, member.viewer, { body: "x", visibility: "members", groupId: gid })).rejects.toMatchObject({ code: "not_found" });
    expect((await getGroup(d, member.viewer, gid)).archived).toBe(true);
    await expect(getGroup(d, outsider.viewer, gid)).rejects.toMatchObject({ code: "not_found" });
    expect((await listGroups(d, outsider.viewer)).map((g) => g.id)).not.toContain(gid);

    await setGroupArchived(d, owner.viewer, gid, false);
    expect(await getPost(d, member.viewer, id)).not.toBeNull();
  });

  it("グループのオーナーは、閉じたグループでも、先に移さないと退会できない", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    await expect(withdraw(d, owner.viewer, { password: PASSWORD, mode: "anonymize" })).rejects.toMatchObject({ code: "invalid" });
    await setGroupArchived(d, owner.viewer, gid, true);
    await expect(withdraw(d, owner.viewer, { password: PASSWORD, mode: "anonymize" })).rejects.toMatchObject({ code: "invalid" });
    await setGroupArchived(d, owner.viewer, gid, false);
    await transferGroupOwnership(d, owner.viewer, gid, member.user.id);
    await withdraw(d, owner.viewer, { password: PASSWORD, mode: "anonymize" });
    expect(await d.select().from(groupMembers).where(eq(groupMembers.userId, owner.user.id))).toHaveLength(0);
  });

  it("オーナーが停止されても、サイトの管理者がオーナーを指定し直せる。オーナーのいないグループは再開できない", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const plain = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    await setGroupArchived(d, owner.viewer, gid, true);
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, owner.user.id));

    await expect(setGroupArchived(d, admin.viewer, gid, false)).rejects.toMatchObject({ code: "conflict" });
    await expect(assignGroupOwnerByAdmin(d, plain.viewer, gid, member.user.id)).rejects.toMatchObject({ code: "forbidden" });
    expect((await listGroupMembers(d, admin.viewer, gid)).active.map((m) => m.id)).toContain(member.user.id);
    await assignGroupOwnerByAdmin(d, admin.viewer, gid, member.user.id);
    const roles = Object.fromEntries((await d.select().from(groupMembers).where(eq(groupMembers.groupId, gid))).map((r) => [r.userId, r.role]));
    expect(roles[member.user.id]).toBe("owner");
    expect(roles[owner.user.id]).toBe("member");
    await setGroupArchived(d, admin.viewer, gid, false);
    expect((await getGroup(d, member.viewer, gid)).isOwner).toBe(true);
  });

  it("サイトの管理者は、自分自身や、オーナーが活動中のグループには指定できない。オーナーは DB でも 1 人に限る", async () => {
    const owner = await makeUser(d);
    const member = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, member.viewer, gid);
    await joinGroup(d, admin.viewer, gid);
    await expect(assignGroupOwnerByAdmin(d, admin.viewer, gid, admin.user.id)).rejects.toMatchObject({ code: "invalid" });
    await expect(assignGroupOwnerByAdmin(d, admin.viewer, gid, member.user.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(d.update(groupMembers).set({ role: "owner" }).where(and(eq(groupMembers.groupId, gid), eq(groupMembers.userId, member.user.id)))).rejects.toThrow();
  });

  it("役割の書き換えはオーナーの行に及ばない（同時に移譲された場合も）", async () => {
    const owner = await makeUser(d);
    const m1 = await makeUser(d);
    const { id: gid } = await newGroup(owner);
    await joinGroup(d, m1.viewer, gid);
    await transferGroupOwnership(d, owner.viewer, gid, m1.user.id);
    // 移譲の直後に、古い情報のまま元の管理人（いまはメンバー）が新しい管理人を外そうとしても外れない
    await expect(removeMember(d, owner.viewer, gid, m1.user.id)).rejects.toMatchObject({ code: "forbidden" });
    expect(Object.fromEntries((await d.select().from(groupMembers).where(eq(groupMembers.groupId, gid))).map((r) => [r.userId, r.role]))[m1.user.id]).toBe("owner");
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { notifications, users } from "@/server/db/schema";
import { mentionToken } from "@/lib/richtext";
import { blockUser } from "@/server/services/blocks";
import { addComment, createPost, getPost, listFeed, updatePost } from "@/server/services/posts";
import { befriend, db, makeUser } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const mentionsOf = async (userId: string) =>
  d.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, "mention")));

describe("メンション", () => {
  it("メンションされた人に通知が届き、表示は現在の名前になる（書いた名前は信用しない）", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d, { displayName: "本当の名前" });
    const { id } = await createPost(d, a.viewer, { body: `こんにちは ${mentionToken("偽の名前", b.user.id)}`, visibility: "members" });
    expect(await mentionsOf(b.user.id)).toHaveLength(1);
    const post = await getPost(d, a.viewer, id);
    expect(post!.body).toBe(`こんにちは ${mentionToken("本当の名前", b.user.id)}`);
  });

  it("その投稿を見られない人には通知しない（友達のみの投稿で、友達でない人をメンション）", async () => {
    const a = await makeUser(d);
    const friend = await makeUser(d);
    const stranger = await makeUser(d);
    await befriend(d, a.user.id, friend.user.id);
    await createPost(d, a.viewer, { body: `${mentionToken("友達", friend.user.id)} ${mentionToken("他人", stranger.user.id)}`, visibility: "friends" });
    expect(await mentionsOf(friend.user.id)).toHaveLength(1);
    expect(await mentionsOf(stranger.user.id)).toHaveLength(0);
  });

  it("ブロック関係の相手には通知せず、表示では名前も ID も出さずに「@メンバー」にする", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d, { displayName: "ブロックした人" });
    const c = await makeUser(d);
    await blockUser(d, b.viewer, a.user.id);
    const { id } = await createPost(d, a.viewer, { body: `${mentionToken("B", b.user.id)} さん`, visibility: "members" });
    expect(await mentionsOf(b.user.id)).toHaveLength(0);

    // C が B をメンションした投稿を、B とブロック関係にある A が見る
    const { id: cPost } = await createPost(d, c.viewer, { body: `${mentionToken("B", b.user.id)} へ`, visibility: "members" });
    const seenByA = await getPost(d, a.viewer, cPost);
    expect(seenByA!.body).toBe("@メンバー へ");
    expect(seenByA!.body).not.toContain(b.user.id);
    // 第三者には、そのまま見える
    expect((await getPost(d, c.viewer, cPost))!.body).toContain("ブロックした人");
    void id;
  });

  it("停止中・未承認の人には通知せず、表示も伏せる", async () => {
    const a = await makeUser(d);
    const suspended = await makeUser(d, { status: "suspended" });
    const pending = await makeUser(d, { status: "pending" });
    const { id } = await createPost(d, a.viewer, { body: `${mentionToken("x", suspended.user.id)} ${mentionToken("y", pending.user.id)}`, visibility: "members" });
    expect(await mentionsOf(suspended.user.id)).toHaveLength(0);
    expect(await mentionsOf(pending.user.id)).toHaveLength(0);
    expect((await getPost(d, a.viewer, id))!.body).toBe("@メンバー @メンバー");
  });

  it("コメントでのメンション：投稿者には「コメント」の通知だけ（二重に送らない）", async () => {
    const author = await makeUser(d);
    const commenter = await makeUser(d);
    const third = await makeUser(d);
    const { id } = await createPost(d, author.viewer, { body: "投稿", visibility: "members" });
    await addComment(d, commenter.viewer, { postId: id, body: `${mentionToken("作者", author.user.id)} ${mentionToken("第三者", third.user.id)}` });
    expect(await mentionsOf(author.user.id)).toHaveLength(0);
    expect(await d.select().from(notifications).where(and(eq(notifications.userId, author.user.id), eq(notifications.type, "comment")))).toHaveLength(1);
    expect(await mentionsOf(third.user.id)).toHaveLength(1);
    expect((await getPost(d, author.viewer, id))!.comments[0]!.body).toContain(mentionToken(third.user.displayName, third.user.id));
  });

  it("編集で新しく加わったメンションにだけ通知する。自分自身のメンションは通知しない", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    const c = await makeUser(d);
    const { id } = await createPost(d, a.viewer, { body: `${mentionToken("B", b.user.id)} ${mentionToken("自分", a.user.id)}`, visibility: "members" });
    await updatePost(d, a.viewer, id, { body: `${mentionToken("B", b.user.id)} ${mentionToken("C", c.user.id)}`, visibility: "members" });
    expect(await mentionsOf(b.user.id)).toHaveLength(1);
    expect(await mentionsOf(c.user.id)).toHaveLength(1);
    expect(await mentionsOf(a.user.id)).toHaveLength(0);
  });

  it("1 つの投稿で通知するのは 10 人まで", async () => {
    const a = await makeUser(d);
    const people = await Promise.all(Array.from({ length: 12 }, () => makeUser(d)));
    await createPost(d, a.viewer, { body: people.map((p) => mentionToken("x", p.user.id)).join(" "), visibility: "members" });
    const counts = await Promise.all(people.map(async (p) => (await mentionsOf(p.user.id)).length));
    expect(counts.reduce((s, n) => s + n, 0)).toBe(10);
  });
});

describe("ハッシュタグ", () => {
  it("タグの一覧は公開範囲どおり。編集・削除も反映する", async () => {
    const tag = `テスト${Date.now()}`;
    const a = await makeUser(d);
    const friend = await makeUser(d);
    const other = await makeUser(d);
    await befriend(d, a.user.id, friend.user.id);
    const { id: pub } = await createPost(d, a.viewer, { body: `#${tag} 全員向け`, visibility: "members" });
    const { id: fo } = await createPost(d, a.viewer, { body: `#${tag} 友達向け`, visibility: "friends" });
    const ids = async (v: typeof a.viewer, t = tag) => (await listFeed(d, v, { tag: t.toLowerCase() })).posts.map((p) => p.id);

    expect(await ids(friend.viewer)).toEqual(expect.arrayContaining([pub, fo]));
    expect(await ids(other.viewer)).toEqual([pub]);

    await updatePost(d, a.viewer, pub, { body: "タグを外した", visibility: "members" });
    expect(await ids(other.viewer)).toEqual([]);
  });

  it("停止中の人の投稿はタグの一覧にも出ない", async () => {
    const tag = `停止${Date.now()}`;
    const a = await makeUser(d);
    const viewer = await makeUser(d);
    await createPost(d, a.viewer, { body: `#${tag}`, visibility: "members" });
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, a.user.id));
    expect((await listFeed(d, viewer.viewer, { tag })).posts).toHaveLength(0);
  });
});

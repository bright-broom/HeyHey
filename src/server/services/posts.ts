import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../db/client";
import { comments, groups, media, notifications, postTags, posts, profiles, reactions, users } from "../db/schema";
import { AppError, forbidden, invalid, notFound } from "../lib/errors";
import { assertMember } from "../lib/policy";
import { extractMentionIds, extractTags, maskHiddenMentions, MENTION_RE, resolveMentions, unmaskHiddenMentions } from "../../lib/richtext";
import { activeInOpenGroup, blockedBetween, visibleComment, visiblePost } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";
import { attachmentInput, claimAttachment, type AttachmentInput, type ProcessedAttachment } from "./attachments";
import { MAX_IMAGES_PER_POST, processImage, removeStoredFile, type ProcessedImage } from "./media";
import { notify } from "./notifications";
import { consume } from "./ratelimit";

export const REACTIONS = { like: "いいね", thanks: "ありがとう", wow: "すごい" } as const;
export type ReactionKey = keyof typeof REACTIONS;
export const VISIBILITY_LABEL = { members: "全会員", friends: "友達のみ" } as const;

export type AuthorDTO = { id: string | null; displayName: string; avatarMediaId: string | null };
export type CommentDTO = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  createdAt: Date;
  hidden: boolean;
  isMine: boolean;
  author: AuthorDTO;
  reactions: Record<ReactionKey, number>;
  myReaction: ReactionKey | null;
  replyCount?: number;
};
export type PostDTO = {
  id: string;
  /** グループの投稿なら、そのグループ（一覧でグループ名を添える） */
  group: { id: string; name: string } | null;
  body: string;
  visibility: "members" | "friends";
  createdAt: Date;
  editedAt: Date | null;
  hidden: boolean;
  isMine: boolean;
  author: AuthorDTO;
  /** 画像・動画・ファイル。種類は mime で分ける（fileName は動画・ファイルだけ） */
  media: { id: string; width: number; height: number; mime: string; fileName: string | null; bytes: number }[];
  reactions: Record<ReactionKey, number>;
  myReaction: ReactionKey | null;
  commentCount: number;
  comments: CommentDTO[];
};

const WITHDRAWN: AuthorDTO = { id: null, displayName: "退会したメンバー", avatarMediaId: null };
const emptyReactions = (): Record<ReactionKey, number> => ({ like: 0, thanks: 0, wow: 0 });

async function loadAuthors(db: Db, ids: string[]): Promise<Map<string, AuthorDTO>> {
  const map = new Map<string, AuthorDTO>();
  if (!ids.length) return map;
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, status: users.status, avatarMediaId: profiles.avatarMediaId })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(inArray(users.id, [...new Set(ids)]));
  for (const r of rows) {
    map.set(r.id, r.status === "withdrawn" ? WITHDRAWN : { id: r.id, displayName: r.displayName, avatarMediaId: r.avatarMediaId });
  }
  return map;
}

/**
 * 本文中のメンションを、viewer から見た現在の名前に置き換える。見えない相手（ブロック関係・停止・退会）は
 * 「@メンバー」にして、名前も ID もブラウザに送らない。
 */
async function mentionNames(db: DbOrTx, viewer: Viewer, bodies: string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(bodies.flatMap((b) => [...b.matchAll(MENTION_RE)].map((m) => m[2]!)))];
  const names = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length) {
    const rows = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.status, "active"), sql`(${users.id} = ${viewer.id} OR NOT ${blockedBetween(viewer.id, sql`${users.id}`)})`));
    for (const r of rows) names.set(r.id, r.displayName);
  }
  return names;
}

async function resolveBodies(db: Db, viewer: Viewer, bodies: string[]): Promise<(body: string) => string> {
  const ids = [...new Set(bodies.flatMap((b) => [...b.matchAll(MENTION_RE)].map((m) => m[2]!)))];
  const names = new Map<string, string | null>(ids.map((id) => [id, null]));
  if (ids.length) {
    const rows = await db
      .select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(and(inArray(users.id, ids), eq(users.status, "active"), sql`(${users.id} = ${viewer.id} OR NOT ${blockedBetween(viewer.id, sql`${users.id}`)})`));
    for (const r of rows) names.set(r.id, r.displayName);
  }
  return (body) => (ids.length ? resolveMentions(body, names) : body);
}

async function loadCommentDTOs(db: Db, viewer: Viewer, rows: (typeof comments.$inferSelect)[]): Promise<CommentDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((c) => c.id);
  const [authors, counts, mine, resolve] = await Promise.all([
    loadAuthors(db, rows.map((c) => c.authorId)),
    db
      .select({ commentId: reactions.commentId, type: reactions.type, n: sql<number>`count(*)::int` })
      .from(reactions)
      .where(inArray(reactions.commentId, ids))
      .groupBy(reactions.commentId, reactions.type),
    db
      .select({ commentId: reactions.commentId, type: reactions.type })
      .from(reactions)
      .where(and(eq(reactions.userId, viewer.id), inArray(reactions.commentId, ids))),
    resolveBodies(db, viewer, rows.map((c) => c.body)),
  ]);
  return rows.map((c) => {
    const r = emptyReactions();
    for (const x of counts) if (x.commentId === c.id) r[x.type] = x.n;
    return {
      id: c.id,
      postId: c.postId,
      parentId: c.parentId,
      body: resolve(c.body),
      createdAt: c.createdAt,
      hidden: c.hiddenAt != null,
      isMine: c.authorId === viewer.id,
      author: authors.get(c.authorId) ?? WITHDRAWN,
      reactions: r,
      myReaction: mine.find((m) => m.commentId === c.id)?.type ?? null,
    };
  });
}

/** 投稿行の配列を、画面表示用の DTO（投稿者・画像・リアクション・コメント）に組み立てる */
async function hydrate(db: Db, viewer: Viewer, rows: (typeof posts.$inferSelect)[], mode: "feed" | "detail"): Promise<PostDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((p) => p.id);
  const [authors, mediaRows, reactionCounts, myReactions, commentCounts] = await Promise.all([
    loadAuthors(db, rows.map((p) => p.authorId)),
    db
      .select({ id: media.id, postId: media.postId, width: media.width, height: media.height, mime: media.mime, fileName: media.fileName, bytes: media.bytes })
      .from(media)
      .where(inArray(media.postId, ids))
      .orderBy(asc(media.position)),
    db
      .select({ postId: reactions.postId, type: reactions.type, n: sql<number>`count(*)::int` })
      .from(reactions)
      .where(inArray(reactions.postId, ids))
      .groupBy(reactions.postId, reactions.type),
    db
      .select({ postId: reactions.postId, type: reactions.type })
      .from(reactions)
      .where(and(eq(reactions.userId, viewer.id), inArray(reactions.postId, ids))),
    db
      .select({ postId: comments.postId, n: sql<number>`count(*)::int` })
      .from(comments)
      .where(and(inArray(comments.postId, ids), visibleComment(viewer.id)))
      .groupBy(comments.postId),
  ]);

  // コメント：詳細はすべて、フィードは各投稿の最新 2 件（トップレベルのみ）
  let commentRows: (typeof comments.$inferSelect)[];
  if (mode === "detail") {
    commentRows = await db
      .select()
      .from(comments)
      .where(and(inArray(comments.postId, ids), visibleComment(viewer.id)))
      .orderBy(asc(comments.createdAt));
  } else {
    const ranked = db
      .select({
        id: comments.id,
        rn: sql<number>`row_number() over (partition by ${comments.postId} order by ${comments.createdAt} desc)`.as("rn"),
      })
      .from(comments)
      .where(and(inArray(comments.postId, ids), isNull(comments.parentId), visibleComment(viewer.id)))
      .as("ranked");
    const top = await db.select({ id: ranked.id }).from(ranked).where(sql`${ranked.rn} <= 2`);
    commentRows = top.length
      ? await db.select().from(comments).where(inArray(comments.id, top.map((t) => t.id))).orderBy(asc(comments.createdAt))
      : [];
  }
  const groupIds = [...new Set(rows.map((p) => p.groupId).filter((x): x is string => !!x))];
  const [commentDTOs, resolve, groupRows] = await Promise.all([
    loadCommentDTOs(db, viewer, commentRows),
    resolveBodies(db, viewer, rows.map((p) => p.body)),
    groupIds.length ? db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds)) : Promise.resolve([]),
  ]);
  const groupName = new Map(groupRows.map((g) => [g.id, g.name]));

  return rows.map((p) => {
    const r = emptyReactions();
    for (const x of reactionCounts) if (x.postId === p.id) r[x.type] = x.n;
    return {
      id: p.id,
      group: p.groupId ? { id: p.groupId, name: groupName.get(p.groupId) ?? "グループ" } : null,
      body: resolve(p.body),
      visibility: p.visibility,
      createdAt: p.createdAt,
      editedAt: p.editedAt,
      hidden: p.hiddenAt != null,
      isMine: p.authorId === viewer.id,
      author: authors.get(p.authorId) ?? WITHDRAWN,
      media: mediaRows.filter((m) => m.postId === p.id).map(({ postId: _, ...m }) => m),
      reactions: r,
      myReaction: myReactions.find((m) => m.postId === p.id)?.type ?? null,
      commentCount: commentCounts.find((c) => c.postId === p.id)?.n ?? 0,
      comments: commentDTOs.filter((c) => c.postId === p.id),
    };
  });
}

export const FEED_PAGE_SIZE = 20;

/** 検索語の長さ（F-08） */
export const SEARCH_MAX = 100;

/**
 * 全文検索の条件。本文からメンションの記法を除いてから部分一致で探す
 * （記法には書いた時点の名前が残っているので、いま見えない相手の名前で投稿を探せないように）。
 * 日本語は単語に区切れないので、全文索引ではなく部分一致にする（会員 1,000 人規模では十分に速い）。
 */
function matchesSearch(q: string) {
  const words = q.normalize("NFKC").split(/[\s　]+/).filter(Boolean).slice(0, 5);
  const plain = sql`normalize(regexp_replace(${posts.body}, ${MENTION_RE.source}, '', 'g'), NFKC)`;
  return and(...words.map((w) => sql`${plain} ILIKE ${`%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`))!;
}

/** ホームフィード（新着順）。authorId を渡すとその人の投稿一覧（プロフィール用）、q を渡すと検索結果 */
export async function listFeed(db: Db, viewer: Viewer, opts: { before?: Date | null; authorId?: string; tag?: string; groupId?: string; q?: string } = {}) {
  assertMember(viewer);
  const conds = [visiblePost(viewer.id)];
  const q = opts.q?.trim().slice(0, SEARCH_MAX);
  if (q) conds.push(matchesSearch(q));
  if (opts.before && !Number.isNaN(opts.before.getTime())) conds.push(lt(posts.createdAt, opts.before));
  if (opts.groupId) conds.push(eq(posts.groupId, opts.groupId));
  if (opts.tag) conds.push(sql`EXISTS (SELECT 1 FROM ${postTags} WHERE ${postTags.postId} = ${posts.id} AND ${postTags.tag} = ${opts.tag})`);
  if (opts.authorId) conds.push(eq(posts.authorId, opts.authorId));
  // ホームのフィードからは、ミュートした人の投稿を外す（プロフィールを開けば見える。検索でも見つかる）
  else if (!q) conds.push(sql`NOT EXISTS (SELECT 1 FROM user_mutes um WHERE um.muter_id = ${viewer.id} AND um.muted_id = ${posts.authorId})`);
  const rows = await db
    .select()
    .from(posts)
    .where(and(...conds))
    .orderBy(desc(posts.createdAt))
    .limit(FEED_PAGE_SIZE + 1);
  const hasMore = rows.length > FEED_PAGE_SIZE;
  const page = rows.slice(0, FEED_PAGE_SIZE);
  return { posts: await hydrate(db, viewer, page, "feed"), nextBefore: hasMore ? page.at(-1)!.createdAt : null };
}

/** 編集用の本文（自分の投稿だけ）。見えない相手へのメンションは目印にして渡す */
export async function getPostForEdit(db: Db, viewer: Viewer, postId: string) {
  assertMember(viewer);
  const p = await ownPost(db, viewer, postId).catch(() => null);
  if (!p) return null;
  if (p.groupId && !(await assertStillInGroup(db, viewer, p.groupId).then(() => true, () => false))) return null;
  return { id: p.id, visibility: p.visibility, inGroup: !!p.groupId, body: maskHiddenMentions(p.body, await mentionNames(db, viewer, [p.body])) };
}

export async function getPost(db: Db, viewer: Viewer, postId: string): Promise<PostDTO | null> {
  assertMember(viewer);
  if (!z.uuid().safeParse(postId).success) return null;
  const rows = await db.select().from(posts).where(and(eq(posts.id, postId), visiblePost(viewer.id))).limit(1);
  const [dto] = await hydrate(db, viewer, rows, "detail");
  return dto ?? null;
}

// ───────── 書き込み ─────────

/**
 * メンションされた人に通知する。その投稿を実際に見られる人にだけ送る
 * （「友達のみ」の投稿で友達でない人をメンションしても、存在を知らせない）。
 * ブロック・ミュートは notify() が見る。skip は、すでに別の通知（コメント・返信）を送った人。
 */
async function notifyMentions(db: DbOrTx, viewer: Viewer, postId: string, ids: string[], skip: string[] = [], commentId?: string) {
  const targets = ids.filter((id) => id !== viewer.id && !skip.includes(id));
  if (!targets.length) return;
  const reachable = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        inArray(users.id, targets),
        eq(users.status, "active"),
        sql`${users.termsAcceptedAt} IS NOT NULL`,
        sql`EXISTS (SELECT 1 FROM posts WHERE posts.id = ${postId} AND ${visiblePost(sql`${users.id}`)})`,
        // コメントでのメンションは、そのコメント（と返信先）が見える人にだけ
        commentId ? sql`EXISTS (SELECT 1 FROM comments WHERE comments.id = ${commentId} AND ${visibleComment(sql`${users.id}`)})` : undefined,
      ),
    );
  for (const r of reachable) {
    await notify(db, { userId: r.id, type: "mention", actorId: viewer.id, postId, data: commentId ? { commentId } : {} });
  }
}

async function saveTags(db: DbOrTx, postId: string, body: string) {
  await db.delete(postTags).where(eq(postTags.postId, postId));
  const tags = extractTags(body);
  if (tags.length) await db.insert(postTags).values(tags.map((tag) => ({ postId, tag }))).onConflictDoNothing();
}

const postSchema = z.object({
  body: z.string().max(5000, "本文は 5000 文字以内です。"),
  visibility: z.enum(["members", "friends"], { message: "公開範囲の指定が正しくありません。" }),
});

/** 新規会員（承認から 7 日以内）は投稿頻度を低めに制限する */
async function assertWriteRate(db: Db, viewer: Viewer, kind: "post" | "comment") {
  const [me] = await db.select({ approvedAt: users.approvedAt }).from(users).where(eq(users.id, viewer.id));
  const isNew = !me?.approvedAt || Date.now() - me.approvedAt.getTime() < 7 * 24 * 60 * 60 * 1000;
  const limit = kind === "post" ? (isNew ? 10 : 60) : isNew ? 60 : 300;
  if (!(await consume(db, `${kind}:${viewer.id}`, limit, 60 * 60))) {
    throw new AppError("rate_limited", "短時間に投稿が集中しています。少し時間をおいてください。");
  }
}

export async function createPost(
  db: Db,
  viewer: Viewer,
  input: { body: string; visibility: string; images?: Buffer[]; attachments?: AttachmentInput; groupId?: string | null },
): Promise<{ id: string }> {
  assertMember(viewer);
  // グループの投稿は、そのグループのアクティブなメンバーだけが書ける。公開範囲はグループのメンバー
  const groupId = input.groupId || null;
  if (groupId) {
    if (!z.uuid().safeParse(groupId).success) throw notFound("グループが見つかりません。");
    const [ok] = await db.select({ one: sql`1` }).from(users).where(and(eq(users.id, viewer.id), activeInOpenGroup(viewer.id, sql`${groupId}::uuid`)));
    if (!ok) throw notFound("グループが見つかりません。");
    input = { ...input, visibility: "members" };
  }
  const parsed = postSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const body = parsed.data.body.trim();
  const images = input.images ?? [];
  const attached = attachmentInput.safeParse(input.attachments ?? []);
  if (!attached.success) throw invalid(attached.error.issues[0]?.message ?? "添付を確認してください。");
  if (!body && images.length === 0 && attached.data.length === 0) throw invalid("本文か画像・動画・ファイルのどれかを入れてください。");
  if (images.length > MAX_IMAGES_PER_POST) throw invalid(`画像は ${MAX_IMAGES_PER_POST} 枚までです。`);
  await assertWriteRate(db, viewer, "post");

  const processed: ProcessedImage[] = [];
  const files: ProcessedAttachment[] = [];
  try {
    for (const img of images) processed.push(await processImage(img));
    for (const a of attached.data) files.push(await claimAttachment(viewer, a));
    return await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(posts)
        .values({ authorId: viewer.id, body, visibility: parsed.data.visibility, groupId })
        .returning({ id: posts.id });
      if (processed.length) {
        await tx.insert(media).values(
          processed.map((m, i) => ({
            ownerId: viewer.id,
            postId: p!.id,
            kind: "post" as const,
            storageKey: m.key,
            mime: m.mime,
            width: m.width,
            height: m.height,
            bytes: m.bytes,
            position: i,
          })),
        );
      }
      if (files.length) {
        await tx.insert(media).values(
          files.map((f, i) => ({
            ownerId: viewer.id,
            postId: p!.id,
            kind: "post" as const,
            storageKey: f.key,
            mime: f.mime,
            width: 0,
            height: 0,
            bytes: f.bytes,
            position: processed.length + i,
            fileName: f.fileName,
          })),
        );
      }
      await saveTags(tx, p!.id, body);
      await notifyMentions(tx, viewer, p!.id, extractMentionIds(body));
      return { id: p!.id };
    });
  } catch (e) {
    // 移し終えた分は消す。まだ一時置き場にある分は残す（直して送り直せるように。残りは定期処理が 1 日で消す）
    await Promise.all([...processed, ...files].map((m) => removeStoredFile(m.key)));
    throw e;
  }
}

async function ownPost(db: Db, viewer: Viewer, postId: string) {
  if (!z.uuid().safeParse(postId).success) throw notFound();
  const [p] = await db.select().from(posts).where(and(eq(posts.id, postId), isNull(posts.deletedAt))).limit(1);
  if (!p) throw notFound();
  if (p.authorId !== viewer.id) throw forbidden("自分の投稿のみ編集・削除できます。");
  return p;
}

/** グループの投稿は、いまそのグループのメンバーであるときだけ編集できる（外された後に書き換えさせない） */
async function assertStillInGroup(db: Db, viewer: Viewer, groupId: string | null) {
  if (!groupId) return;
  const [ok] = await db.select({ one: sql`1` }).from(users).where(and(eq(users.id, viewer.id), activeInOpenGroup(viewer.id, sql`${groupId}::uuid`)));
  if (!ok) throw notFound();
}

export async function updatePost(db: Db, viewer: Viewer, postId: string, input: { body: string; visibility: string }) {
  assertMember(viewer);
  const p = await ownPost(db, viewer, postId);
  await assertStillInGroup(db, viewer, p.groupId);
  const parsed = postSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  // 編集画面では見えない相手へのメンションを目印にしてあるので、保存前に元のメンションへ戻す
  const body = unmaskHiddenMentions(parsed.data.body.trim(), p.body, await mentionNames(db, viewer, [p.body]));
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(media).where(eq(media.postId, p.id));
  if (!body && n === 0) throw invalid("本文を入れてください。");
  await db.transaction(async (tx) => {
    // グループの投稿の公開範囲は、グループのメンバーのまま（全会員／友達のみの切り替えはしない）
    await tx.update(posts).set({ body, visibility: p.groupId ? "members" : parsed.data.visibility, editedAt: new Date() }).where(eq(posts.id, p.id));
    await saveTags(tx, p.id, body);
    // 編集で新しく加わったメンションにだけ知らせる
    const before = new Set(extractMentionIds(p.body));
    await notifyMentions(tx, viewer, p.id, extractMentionIds(body).filter((id) => !before.has(id)));
  });
}

export async function deletePost(db: Db, viewer: Viewer, postId: string) {
  assertMember(viewer);
  const p = await ownPost(db, viewer, postId);
  // 投稿は論理削除だが、画像は実体ごと消す（見えない画像をディスクに残さない）
  const removed = await db.transaction(async (tx) => {
    await tx.update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, p.id));
    return tx.delete(media).where(eq(media.postId, p.id)).returning({ key: media.storageKey });
  });
  await Promise.all(removed.map((m) => removeStoredFile(m.key)));
}

// ───────── コメント ─────────

export async function addComment(db: Db, viewer: Viewer, input: { postId: string; body: string; parentId?: string | null }) {
  assertMember(viewer);
  const body = (input.body ?? "").trim();
  if (!body) throw invalid("コメントを入力してください。");
  if (body.length > 2000) throw invalid("コメントは 2000 文字以内です。");
  if (!z.uuid().safeParse(input.postId).success) throw notFound();

  const [post] = await db.select().from(posts).where(and(eq(posts.id, input.postId), visiblePost(viewer.id))).limit(1);
  if (!post) throw notFound("投稿が見つかりません。");

  let parent: typeof comments.$inferSelect | undefined;
  if (input.parentId) {
    if (!z.uuid().safeParse(input.parentId).success) throw notFound();
    [parent] = await db
      .select()
      .from(comments)
      .where(and(eq(comments.id, input.parentId), eq(comments.postId, post.id), visibleComment(viewer.id)))
      .limit(1);
    if (!parent) throw notFound("返信先のコメントが見つかりません。");
    if (parent.parentId) throw invalid("返信への返信はできません（1 階層まで）。");
  }
  await assertWriteRate(db, viewer, "comment");

  return db.transaction(async (tx) => {
    const [c] = await tx
      .insert(comments)
      .values({ postId: post.id, authorId: viewer.id, body, parentId: parent?.id ?? null })
      .returning({ id: comments.id });
    await notify(tx, { userId: post.authorId, type: "comment", actorId: viewer.id, postId: post.id });
    if (parent && parent.authorId !== post.authorId) {
      await notify(tx, { userId: parent.authorId, type: "reply", actorId: viewer.id, postId: post.id });
    }
    await notifyMentions(tx, viewer, post.id, extractMentionIds(body), [post.authorId, ...(parent ? [parent.authorId] : [])], c!.id);
    return { id: c!.id };
  });
}

export async function deleteComment(db: Db, viewer: Viewer, commentId: string) {
  assertMember(viewer);
  if (!z.uuid().safeParse(commentId).success) throw notFound();
  const [c] = await db.select().from(comments).where(and(eq(comments.id, commentId), isNull(comments.deletedAt))).limit(1);
  if (!c) throw notFound();
  if (c.authorId !== viewer.id) throw forbidden("自分のコメントのみ削除できます。");
  await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, c.id));
}

// ───────── リアクション ─────────

/** 同じ種類を押し直すと取り消し、別の種類なら付け替え（1 人 1 件） */
export async function toggleReaction(
  db: Db,
  viewer: Viewer,
  target: { postId?: string; commentId?: string },
  type: string,
) {
  assertMember(viewer);
  if (!(type in REACTIONS)) throw invalid("リアクションの種類が正しくありません。");
  const t = type as ReactionKey;

  let postId: string | undefined;
  let postAuthorId: string | undefined;
  if (target.postId) {
    if (!z.uuid().safeParse(target.postId).success) throw notFound();
    const [p] = await db.select({ id: posts.id, authorId: posts.authorId }).from(posts).where(and(eq(posts.id, target.postId), visiblePost(viewer.id)));
    if (!p) throw notFound();
    postId = p.id;
    postAuthorId = p.authorId;
  } else if (target.commentId) {
    if (!z.uuid().safeParse(target.commentId).success) throw notFound();
    const [c] = await db.select({ id: comments.id }).from(comments).where(and(eq(comments.id, target.commentId), visibleComment(viewer.id)));
    if (!c) throw notFound();
  } else throw invalid("対象が指定されていません。");

  if (!(await consume(db, `react:${viewer.id}`, 300, 60 * 60))) {
    throw new AppError("rate_limited", "短時間の操作が多すぎます。少し時間をおいてください。");
  }
  const col = postId ? reactions.postId : reactions.commentId;
  const id = (postId ?? target.commentId)!;
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(reactions).where(and(eq(reactions.userId, viewer.id), eq(col, id)));
    if (existing?.type === t) {
      await tx.delete(reactions).where(eq(reactions.id, existing.id));
    } else if (existing) {
      await tx.update(reactions).set({ type: t }).where(eq(reactions.id, existing.id));
    } else {
      await tx.insert(reactions).values({ userId: viewer.id, postId: postId ?? null, commentId: postId ? null : id, type: t });
      // 付けたり外したりを繰り返しても、同じ人・同じ投稿のリアクション通知は 1 日 1 回まで
      if (postId && postAuthorId) {
        const [recent] = await tx
          .select({ id: notifications.id })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, postAuthorId),
              eq(notifications.actorId, viewer.id),
              eq(notifications.postId, postId),
              eq(notifications.type, "reaction"),
              sql`${notifications.createdAt} > now() - interval '1 day'`,
            ),
          )
          .limit(1);
        if (!recent) await notify(tx, { userId: postAuthorId, type: "reaction", actorId: viewer.id, postId, data: { reaction: t } });
      }
    }
  });
}

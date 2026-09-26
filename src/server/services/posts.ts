import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { comments, media, posts, profiles, reactions, users } from "../db/schema";
import { AppError, forbidden, invalid, notFound } from "../lib/errors";
import { assertMember } from "../lib/policy";
import { visibleComment, visiblePost } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";
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
  body: string;
  visibility: "members" | "friends";
  createdAt: Date;
  editedAt: Date | null;
  hidden: boolean;
  isMine: boolean;
  author: AuthorDTO;
  media: { id: string; width: number; height: number }[];
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

async function loadCommentDTOs(db: Db, viewer: Viewer, rows: (typeof comments.$inferSelect)[]): Promise<CommentDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((c) => c.id);
  const [authors, counts, mine] = await Promise.all([
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
  ]);
  return rows.map((c) => {
    const r = emptyReactions();
    for (const x of counts) if (x.commentId === c.id) r[x.type] = x.n;
    return {
      id: c.id,
      postId: c.postId,
      parentId: c.parentId,
      body: c.body,
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
      .select({ id: media.id, postId: media.postId, width: media.width, height: media.height })
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
  const commentDTOs = await loadCommentDTOs(db, viewer, commentRows);

  return rows.map((p) => {
    const r = emptyReactions();
    for (const x of reactionCounts) if (x.postId === p.id) r[x.type] = x.n;
    return {
      id: p.id,
      body: p.body,
      visibility: p.visibility,
      createdAt: p.createdAt,
      editedAt: p.editedAt,
      hidden: p.hiddenAt != null,
      isMine: p.authorId === viewer.id,
      author: authors.get(p.authorId) ?? WITHDRAWN,
      media: mediaRows.filter((m) => m.postId === p.id).map(({ id, width, height }) => ({ id, width, height })),
      reactions: r,
      myReaction: myReactions.find((m) => m.postId === p.id)?.type ?? null,
      commentCount: commentCounts.find((c) => c.postId === p.id)?.n ?? 0,
      comments: commentDTOs.filter((c) => c.postId === p.id),
    };
  });
}

export const FEED_PAGE_SIZE = 20;

/** ホームフィード（新着順）。authorId を渡すとその人の投稿一覧（プロフィール用） */
export async function listFeed(db: Db, viewer: Viewer, opts: { before?: Date | null; authorId?: string } = {}) {
  assertMember(viewer);
  const conds = [visiblePost(viewer.id)];
  if (opts.before && !Number.isNaN(opts.before.getTime())) conds.push(lt(posts.createdAt, opts.before));
  if (opts.authorId) conds.push(eq(posts.authorId, opts.authorId));
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

export async function getPost(db: Db, viewer: Viewer, postId: string): Promise<PostDTO | null> {
  assertMember(viewer);
  if (!z.uuid().safeParse(postId).success) return null;
  const rows = await db.select().from(posts).where(and(eq(posts.id, postId), visiblePost(viewer.id))).limit(1);
  const [dto] = await hydrate(db, viewer, rows, "detail");
  return dto ?? null;
}

// ───────── 書き込み ─────────

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
  input: { body: string; visibility: string; images?: Buffer[] },
): Promise<{ id: string }> {
  assertMember(viewer);
  const parsed = postSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const body = parsed.data.body.trim();
  const images = input.images ?? [];
  if (!body && images.length === 0) throw invalid("本文か画像のどちらかを入れてください。");
  if (images.length > MAX_IMAGES_PER_POST) throw invalid(`画像は ${MAX_IMAGES_PER_POST} 枚までです。`);
  await assertWriteRate(db, viewer, "post");

  const processed: ProcessedImage[] = [];
  try {
    for (const img of images) processed.push(await processImage(img));
    return await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(posts)
        .values({ authorId: viewer.id, body, visibility: parsed.data.visibility })
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
      return { id: p!.id };
    });
  } catch (e) {
    await Promise.all(processed.map((m) => removeStoredFile(m.key)));
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

export async function updatePost(db: Db, viewer: Viewer, postId: string, input: { body: string; visibility: string }) {
  assertMember(viewer);
  const p = await ownPost(db, viewer, postId);
  const parsed = postSchema.safeParse(input);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const body = parsed.data.body.trim();
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(media).where(eq(media.postId, p.id));
  if (!body && n === 0) throw invalid("本文を入れてください。");
  await db
    .update(posts)
    .set({ body, visibility: parsed.data.visibility, editedAt: new Date() })
    .where(eq(posts.id, p.id));
}

export async function deletePost(db: Db, viewer: Viewer, postId: string) {
  assertMember(viewer);
  const p = await ownPost(db, viewer, postId);
  await db.update(posts).set({ deletedAt: new Date() }).where(eq(posts.id, p.id));
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
      if (postId && postAuthorId) {
        await notify(tx, { userId: postAuthorId, type: "reaction", actorId: viewer.id, postId, data: { reaction: t } });
      }
    }
  });
}

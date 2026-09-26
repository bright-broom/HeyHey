import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { comments, posts } from "../db/schema";

/**
 * 公開範囲の判定を SQL の条件式として 1 か所に定義する。
 * フィード・投稿詳細・プロフィール・画像配信・コメントのすべてがこの関数を使うので、
 * 「一覧では見えないのに画像 URL だと見える」といった判定のズレが起きない。
 *
 * 前提：呼び出し側で viewer が承認済み会員であることを確認済み（assertMember）。
 */
export function areFriends(a: SQL | string, b: SQL | string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM friendships f
    WHERE f.status = 'accepted'
      AND ((f.requester_id = ${a} AND f.addressee_id = ${b})
        OR (f.requester_id = ${b} AND f.addressee_id = ${a}))
  )`;
}

/**
 * a と b のどちらかがもう一方をブロックしているか。ブロックは双方向に効く
 * （ブロックした側もされた側も、相手の投稿・コメントが見えない）。
 */
export function blockedBetween(a: SQL | string, b: SQL | string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM user_blocks ub
    WHERE (ub.blocker_id = ${a} AND ub.blocked_id = ${b})
       OR (ub.blocker_id = ${b} AND ub.blocked_id = ${a})
  )`;
}

/** 投稿者が「表示してよい状態」か。停止中の会員の投稿は隠し、退会（匿名化）済みは残す */
function authorIsShowable(authorIdCol: SQL | typeof posts.authorId | typeof comments.authorId): SQL {
  return sql`EXISTS (SELECT 1 FROM users au WHERE au.id = ${authorIdCol} AND au.status IN ('active', 'withdrawn'))`;
}

export function visiblePost(viewerId: string): SQL {
  return and(
    isNull(posts.deletedAt),
    or(
      // 自分の投稿は非表示処分中でも見える（画面では「非表示中」と表示）
      eq(posts.authorId, viewerId),
      and(
        isNull(posts.hiddenAt),
        authorIsShowable(posts.authorId),
        sql`NOT ${blockedBetween(viewerId, sql`${posts.authorId}`)}`,
        or(
          eq(posts.visibility, "members"),
          and(eq(posts.visibility, "friends"), areFriends(viewerId, sql`${posts.authorId}`)),
        ),
      ),
    ),
  )!;
}

/** コメントは「親投稿が見えること」＋コメント自体の状態で判定 */
export function visibleComment(viewerId: string): SQL {
  return and(
    isNull(comments.deletedAt),
    sql`EXISTS (SELECT 1 FROM posts WHERE posts.id = ${comments.postId} AND ${visiblePost(viewerId)})`,
    or(
      eq(comments.authorId, viewerId),
      and(isNull(comments.hiddenAt), authorIsShowable(comments.authorId), sql`NOT ${blockedBetween(viewerId, sql`${comments.authorId}`)}`),
    ),
  )!;
}

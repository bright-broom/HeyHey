import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { comments, events, posts } from "../db/schema";

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

/** a がそのグループのアクティブなメンバーで、グループが閉じられていないか */
export function activeInOpenGroup(a: SQL | string, groupIdCol: SQL | typeof posts.groupId | typeof events.groupId): SQL {
  return sql`EXISTS (
    SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
    WHERE gm.group_id = ${groupIdCol} AND gm.user_id = ${a} AND gm.status = 'active' AND g.archived_at IS NULL
  )`;
}

/** 投稿者が「表示してよい状態」か。停止中の会員の投稿は隠し、退会（匿名化）済みは残す */
function authorIsShowable(authorIdCol: SQL | typeof posts.authorId | typeof comments.authorId | typeof events.creatorId): SQL {
  return sql`EXISTS (SELECT 1 FROM users au WHERE au.id = ${authorIdCol} AND au.status IN ('active', 'withdrawn'))`;
}

/** viewerId は会員 ID の文字列か、別の問い合わせの会員 ID 列（「この人から見えるか」を SQL の中で判定するとき） */
export function visiblePost(viewerId: string | SQL): SQL {
  return and(
    isNull(posts.deletedAt),
    or(
      // 自分の投稿は非表示処分中でも見える（画面では「非表示中」と表示）。
      // ただしグループの投稿は、自分もいまそのグループのメンバーであるときだけ
      // （外された・閉じたグループの投稿を入口に、新しいやりとりを読み書きさせない）
      and(eq(posts.authorId, viewerId), or(isNull(posts.groupId), activeInOpenGroup(viewerId, posts.groupId))),
      and(
        isNull(posts.hiddenAt),
        authorIsShowable(posts.authorId),
        sql`NOT ${blockedBetween(viewerId, sql`${posts.authorId}`)}`,
        or(
          // コミュニティ全体の投稿：全会員／友達のみ
          and(
            isNull(posts.groupId),
            or(eq(posts.visibility, "members"), and(eq(posts.visibility, "friends"), areFriends(viewerId, sql`${posts.authorId}`))),
          ),
          // グループの投稿：そのグループのアクティブなメンバーだけ（閉じたグループは誰にも見せない）
          and(isNotNull(posts.groupId), activeInOpenGroup(viewerId, posts.groupId)),
        ),
      ),
    ),
  )!;
}

/** コメントは「親投稿が見えること」＋コメント自体の状態で判定 */
export function visibleComment(viewerId: string | SQL): SQL {
  return and(
    isNull(comments.deletedAt),
    sql`EXISTS (SELECT 1 FROM posts WHERE posts.id = ${comments.postId} AND ${visiblePost(viewerId)})`,
    or(
      eq(comments.authorId, viewerId),
      and(isNull(comments.hiddenAt), authorIsShowable(comments.authorId), sql`NOT ${blockedBetween(viewerId, sql`${comments.authorId}`)}`),
    ),
    // 返信は、返信先のコメントが見えるときだけ見える（見えないコメントへの返信が数や一覧に出ないように）
    sql`(${comments.parentId} IS NULL OR EXISTS (
      SELECT 1 FROM comments pc
      WHERE pc.id = ${comments.parentId} AND pc.deleted_at IS NULL
        AND (pc.author_id = ${viewerId} OR (pc.hidden_at IS NULL
          AND EXISTS (SELECT 1 FROM users pau WHERE pau.id = pc.author_id AND pau.status IN ('active', 'withdrawn'))
          AND NOT ${blockedBetween(viewerId, sql`pc.author_id`)}))
    ))`,
  )!;
}

/**
 * イベント（F-17）の見える範囲。投稿と同じ考え方：
 * 全会員向けは会員なら誰でも、グループのイベントはそのグループのアクティブなメンバーだけ。
 * 作った人とブロック関係なら見えない。非表示は作った人にだけ見える。中止したイベントは見える（中止を伝えるため）。
 */
export function visibleEvent(viewerId: string | SQL): SQL {
  return and(
    isNull(events.deletedAt),
    or(isNull(events.groupId), activeInOpenGroup(viewerId, events.groupId)),
    or(
      eq(events.creatorId, viewerId),
      and(isNull(events.hiddenAt), authorIsShowable(events.creatorId), sql`NOT ${blockedBetween(viewerId, sql`${events.creatorId}`)}`),
    ),
  )!;
}

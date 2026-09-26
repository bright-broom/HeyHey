import Link from "next/link";
import { deleteCommentAction, deletePostAction, reactAction } from "@/app/actions/content";
import { REACTIONS, VISIBILITY_LABEL, type CommentDTO, type PostDTO } from "@/server/services/posts";
import { Avatar } from "./Avatar";
import { CommentForm } from "./CommentForm";
import { ReportForm } from "./ReportForm";
import { timeAgo } from "./time";

function AuthorName({ author, className = "" }: { author: PostDTO["author"]; className?: string }) {
  return author.id ? (
    <Link href={`/u/${author.id}`} className={`font-medium hover:underline hover:underline-offset-4 ${className}`}>
      {author.displayName}
    </Link>
  ) : (
    <span className={`font-medium text-muted ${className}`}>{author.displayName}</span>
  );
}

function Menu({ children, label = "メニュー" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="relative">
      <summary
        className="flex h-8 w-8 cursor-pointer list-none items-center justify-center text-muted transition-colors hover:text-ink"
        aria-label={label}
      >
        <span aria-hidden className="flex gap-[3px]">
          <i className="block h-[3px] w-[3px] rounded-full bg-current" />
          <i className="block h-[3px] w-[3px] rounded-full bg-current" />
          <i className="block h-[3px] w-[3px] rounded-full bg-current" />
        </span>
      </summary>
      <div className="fade-in absolute right-0 z-10 mt-2 w-72 space-y-3 border border-line bg-light p-4 shadow-lg">{children}</div>
    </details>
  );
}

/** 画像は角を落とさず、細い目地（2px）で並べる */
function MediaGrid({ media }: { media: PostDTO["media"] }) {
  if (!media.length) return null;
  const cols = media.length === 1 ? "grid-cols-1" : "grid-cols-2";
  return (
    <div className={`mt-5 grid ${cols} gap-0.5 bg-line`}>
      {media.map((m) => (
        <a key={m.id} href={`/api/media/${m.id}`} target="_blank" rel="noopener" className="block bg-concrete">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media/${m.id}`}
            alt=""
            width={m.width}
            height={m.height}
            loading="lazy"
            className={`w-full object-cover ${media.length === 1 ? "max-h-[560px]" : "aspect-square"}`}
          />
        </a>
      ))}
    </div>
  );
}

/** リアクションは枠を持たない文字だけ。押したものだけ墨になり、下に細い線が入る */
function ReactionBar({ target, reactions, mine, compact }: { target: { postId?: string; commentId?: string }; reactions: PostDTO["reactions"]; mine: PostDTO["myReaction"]; compact?: boolean }) {
  const keys = target.postId ? (Object.keys(REACTIONS) as (keyof typeof REACTIONS)[]) : (["like"] as const);
  return (
    <div className={`flex flex-wrap items-center ${compact ? "gap-4" : "gap-6"}`}>
      {keys.map((k) => (
        <form key={k} action={reactAction}>
          {target.postId ? <input type="hidden" name="postId" value={target.postId} /> : <input type="hidden" name="commentId" value={target.commentId} />}
          <input type="hidden" name="type" value={k} />
          <button
            type="submit"
            aria-pressed={mine === k}
            className={`py-1 text-xs tracking-[0.08em] transition-colors duration-200 ${
              mine === k ? "text-ink underline decoration-ink underline-offset-[6px]" : "text-muted hover:text-ink"
            }`}
          >
            {REACTIONS[k]}
            {reactions[k] > 0 && <span className="ml-1.5 tabular-nums">{reactions[k]}</span>}
          </button>
        </form>
      ))}
    </div>
  );
}

function CommentItem({ c, replies, allowReply }: { c: CommentDTO; replies: CommentDTO[]; allowReply: boolean }) {
  return (
    <li className="flex gap-3">
      <Avatar name={c.author.displayName} mediaId={c.author.avatarMediaId} size={28} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
          <AuthorName author={c.author} />
          <span className="text-[11px] text-muted">{timeAgo(c.createdAt)}</span>
          {c.hidden && <span className="badge text-warn">非表示中</span>}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-[1.85]">{c.body}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-4 text-xs text-muted">
          <ReactionBar target={{ commentId: c.id }} reactions={c.reactions} mine={c.myReaction} compact />
          {c.isMine ? (
            <form action={deleteCommentAction}>
              <input type="hidden" name="commentId" value={c.id} />
              <button className="tracking-[0.08em] hover:text-danger">削除</button>
            </form>
          ) : (
            <details>
              <summary className="cursor-pointer list-none tracking-[0.08em] hover:text-ink">通報</summary>
              <div className="mt-3 w-72 border border-line bg-light p-4">
                <ReportForm targetType="comment" targetId={c.id} />
              </div>
            </details>
          )}
          {allowReply && (
            <details className="w-full">
              <summary className="cursor-pointer list-none tracking-[0.08em] hover:text-ink">返信する</summary>
              <div className="mt-3">
                <CommentForm postId={c.postId} parentId={c.id} placeholder="返信を書く" />
              </div>
            </details>
          )}
        </div>
        {replies.length > 0 && (
          <ul className="mt-5 space-y-5 border-l border-line pl-5">
            {replies.map((r) => (
              <CommentItem key={r.id} c={r} replies={[]} allowReply={false} />
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * 投稿。箱に入れず、上の 1px の線と余白だけで区切る。
 * 読む順（誰が → 何を → 反応）に沿って、上から下へ一筆で視線が流れる配置にする。
 */
export function PostCard({ post, mode = "feed" }: { post: PostDTO; mode?: "feed" | "detail" }) {
  const top = post.comments.filter((c) => !c.parentId);
  const repliesOf = (id: string) => post.comments.filter((c) => c.parentId === id);
  return (
    <article className="fade-in border-t border-line py-10" data-testid="post" data-post-id={post.id}>
      <header className="flex items-center gap-3">
        <Avatar name={post.author.displayName} mediaId={post.author.avatarMediaId} size={36} />
        <div className="min-w-0 flex-1 leading-tight">
          <AuthorName author={post.author} className="text-[15px]" />
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] tracking-[0.06em] text-muted">
            <Link href={`/posts/${post.id}`} className="hover:text-ink">
              {timeAgo(post.createdAt)}
            </Link>
            <span aria-hidden>／</span>
            <span>{VISIBILITY_LABEL[post.visibility]}</span>
            {post.editedAt && (
              <>
                <span aria-hidden>／</span>
                <span>編集済み</span>
              </>
            )}
          </div>
        </div>
        {post.hidden && <span className="badge text-warn">非表示中（管理者対応）</span>}
        <Menu>
          {post.isMine ? (
            <>
              <Link href={`/posts/${post.id}/edit`} className="block py-1.5 text-sm hover:underline hover:underline-offset-4">
                編集する
              </Link>
              <details>
                <summary className="cursor-pointer list-none py-1.5 text-sm text-danger hover:underline hover:underline-offset-4">削除する</summary>
                <form action={deletePostAction} className="mt-3 space-y-3">
                  <input type="hidden" name="postId" value={post.id} />
                  <p className="text-xs leading-relaxed text-muted">削除すると元に戻せません。画像も消えます。</p>
                  <button className="btn-danger w-full">削除を確定する</button>
                </form>
              </details>
            </>
          ) : (
            <>
              <p className="plaque">REPORT</p>
              <ReportForm targetType="post" targetId={post.id} />
            </>
          )}
        </Menu>
      </header>

      {post.body && <p className="mt-5 whitespace-pre-wrap break-words text-[15.5px] leading-[1.95]">{post.body}</p>}
      <MediaGrid media={post.media} />

      <div className="mt-6 flex items-center justify-between gap-4">
        <ReactionBar target={{ postId: post.id }} reactions={post.reactions} mine={post.myReaction} />
        <Link href={`/posts/${post.id}`} className="text-xs tracking-[0.08em] text-muted hover:text-ink">
          コメント <span className="tabular-nums">{post.commentCount}</span>
        </Link>
      </div>

      {(top.length > 0 || mode === "detail") && (
        <div className="mt-6 space-y-5 border-l border-line pl-5">
          {top.length > 0 && (
            <ul className="space-y-6">
              {top.map((c) => (
                <CommentItem key={c.id} c={c} replies={mode === "detail" ? repliesOf(c.id) : []} allowReply={mode === "detail"} />
              ))}
            </ul>
          )}
          {mode === "feed" && post.commentCount > top.length && (
            <Link href={`/posts/${post.id}`} className="btn-link block text-xs">
              コメントをすべて見る
            </Link>
          )}
        </div>
      )}
      <div className="mt-5">
        <CommentForm postId={post.id} />
      </div>
    </article>
  );
}

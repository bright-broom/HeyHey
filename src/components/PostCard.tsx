import Link from "next/link";
import { deleteCommentAction, deletePostAction, reactAction } from "@/app/actions/content";
import { REACTIONS, VISIBILITY_LABEL, type CommentDTO, type PostDTO } from "@/server/services/posts";
import { Avatar } from "./Avatar";
import { CommentForm } from "./CommentForm";
import { ReportForm } from "./ReportForm";
import { timeAgo } from "./time";

function AuthorName({ author }: { author: PostDTO["author"] }) {
  return author.id ? (
    <Link href={`/u/${author.id}`} className="font-semibold hover:underline">
      {author.displayName}
    </Link>
  ) : (
    <span className="font-semibold text-muted">{author.displayName}</span>
  );
}

function Menu({ children, label = "メニュー" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="relative">
      <summary className="cursor-pointer list-none rounded-md px-2 py-1 text-muted hover:bg-canvas" aria-label={label}>
        …
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-64 space-y-2 rounded-lg border border-line bg-card p-3 shadow-lg">{children}</div>
    </details>
  );
}

function MediaGrid({ media }: { media: PostDTO["media"] }) {
  if (!media.length) return null;
  const cols = media.length === 1 ? "grid-cols-1" : "grid-cols-2";
  return (
    <div className={`grid ${cols} gap-1 overflow-hidden rounded-lg`}>
      {media.map((m) => (
        <a key={m.id} href={`/api/media/${m.id}`} target="_blank" rel="noopener" className="block bg-canvas">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/api/media/${m.id}`}
            alt=""
            width={m.width}
            height={m.height}
            loading="lazy"
            className={`w-full object-cover ${media.length === 1 ? "max-h-[520px]" : "aspect-square"}`}
          />
        </a>
      ))}
    </div>
  );
}

function ReactionBar({ target, reactions, mine }: { target: { postId?: string; commentId?: string }; reactions: PostDTO["reactions"]; mine: PostDTO["myReaction"] }) {
  const keys = target.postId ? (Object.keys(REACTIONS) as (keyof typeof REACTIONS)[]) : (["like"] as const);
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((k) => (
        <form key={k} action={reactAction}>
          {target.postId ? <input type="hidden" name="postId" value={target.postId} /> : <input type="hidden" name="commentId" value={target.commentId} />}
          <input type="hidden" name="type" value={k} />
          <button
            type="submit"
            aria-pressed={mine === k}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              mine === k ? "border-brand bg-brand-soft text-brand" : "border-line text-muted hover:bg-canvas"
            }`}
          >
            {REACTIONS[k]}
            {reactions[k] > 0 && <span className="ml-1 tabular-nums">{reactions[k]}</span>}
          </button>
        </form>
      ))}
    </div>
  );
}

function CommentItem({ c, replies, allowReply }: { c: CommentDTO; replies: CommentDTO[]; allowReply: boolean }) {
  return (
    <li className="flex gap-2">
      <Avatar name={c.author.displayName} mediaId={c.author.avatarMediaId} size={30} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="rounded-xl bg-canvas px-3 py-2">
          <div className="flex items-center gap-2 text-sm">
            <AuthorName author={c.author} />
            {c.hidden && <span className="badge bg-warn-soft text-warn">非表示中</span>}
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{c.body}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 px-1 text-xs text-muted">
          <span>{timeAgo(c.createdAt)}</span>
          <ReactionBar target={{ commentId: c.id }} reactions={c.reactions} mine={c.myReaction} />
          {c.isMine ? (
            <form action={deleteCommentAction}>
              <input type="hidden" name="commentId" value={c.id} />
              <button className="hover:text-danger hover:underline">削除</button>
            </form>
          ) : (
            <details>
              <summary className="cursor-pointer list-none hover:underline">通報</summary>
              <div className="mt-2 w-64">
                <ReportForm targetType="comment" targetId={c.id} />
              </div>
            </details>
          )}
        </div>
        {replies.length > 0 && (
          <ul className="mt-2 space-y-2">
            {replies.map((r) => (
              <CommentItem key={r.id} c={r} replies={[]} allowReply={false} />
            ))}
          </ul>
        )}
        {allowReply && (
          <details className="px-1">
            <summary className="cursor-pointer list-none text-xs font-medium text-muted hover:underline">返信する</summary>
            <div className="mt-2">
              <CommentForm postId={c.postId} parentId={c.id} placeholder="返信を書く…" />
            </div>
          </details>
        )}
      </div>
    </li>
  );
}

export function PostCard({ post, mode = "feed" }: { post: PostDTO; mode?: "feed" | "detail" }) {
  const top = post.comments.filter((c) => !c.parentId);
  const repliesOf = (id: string) => post.comments.filter((c) => c.parentId === id);
  return (
    <article className="card space-y-3 p-4" data-testid="post" data-post-id={post.id}>
      <header className="flex items-start gap-3">
        <Avatar name={post.author.displayName} mediaId={post.author.avatarMediaId} />
        <div className="min-w-0 flex-1">
          <AuthorName author={post.author} />
          <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <Link href={`/posts/${post.id}`} className="hover:underline">
              {timeAgo(post.createdAt)}
            </Link>
            <span>・{VISIBILITY_LABEL[post.visibility]}</span>
            {post.editedAt && <span>・編集済み</span>}
          </div>
        </div>
        {post.hidden && <span className="badge bg-warn-soft text-warn">非表示中（管理者対応）</span>}
        <Menu>
          {post.isMine ? (
            <>
              <Link href={`/posts/${post.id}/edit`} className="block rounded px-2 py-1 text-sm hover:bg-canvas">
                編集する
              </Link>
              <details>
                <summary className="cursor-pointer list-none rounded px-2 py-1 text-sm text-danger hover:bg-canvas">削除する</summary>
                <form action={deletePostAction} className="mt-2 space-y-2 px-2">
                  <input type="hidden" name="postId" value={post.id} />
                  <p className="text-xs text-muted">削除すると元に戻せません。</p>
                  <button className="btn-danger w-full py-1.5">削除を確定する</button>
                </form>
              </details>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold">この投稿を通報</p>
              <ReportForm targetType="post" targetId={post.id} />
            </>
          )}
        </Menu>
      </header>

      {post.body && <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">{post.body}</p>}
      <MediaGrid media={post.media} />

      <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
        <ReactionBar target={{ postId: post.id }} reactions={post.reactions} mine={post.myReaction} />
        <Link href={`/posts/${post.id}`} className="text-xs text-muted hover:underline">
          コメント {post.commentCount} 件
        </Link>
      </div>

      {top.length > 0 && (
        <ul className="space-y-3">
          {top.map((c) => (
            <CommentItem key={c.id} c={c} replies={mode === "detail" ? repliesOf(c.id) : []} allowReply={mode === "detail"} />
          ))}
        </ul>
      )}
      {mode === "feed" && post.commentCount > top.length && (
        <Link href={`/posts/${post.id}`} className="btn-link block">
          コメントをすべて見る
        </Link>
      )}
      <CommentForm postId={post.id} />
    </article>
  );
}

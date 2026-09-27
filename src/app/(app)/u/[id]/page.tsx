import Link from "next/link";
import { notFound } from "next/navigation";
import { friendAction, relationAction } from "@/app/actions/social";
import { Avatar } from "@/components/Avatar";
import { PostCard } from "@/components/PostCard";
import { ReportForm } from "@/components/ReportForm";
import { getDb } from "@/server/db/client";
import { getProfile } from "@/server/services/members";
import { listFeed } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "プロフィール" };

function FriendButton({ userId, rel }: { userId: string; rel: string }) {
  const button = (op: string, label: string, cls = "btn-ghost") => (
    <form action={friendAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="op" value={op} />
      <button className={cls}>{label}</button>
    </form>
  );
  switch (rel) {
    case "none":
      return button("request", "友達申請する", "btn-primary");
    case "outgoing":
      return button("remove", "申請を取り消す");
    case "incoming":
      return (
        <div className="flex gap-2">
          {button("accept", "承認する", "btn-primary")}
          {button("decline", "見送る")}
        </div>
      );
    case "friends":
      return (
        <details>
          <summary className="btn-ghost cursor-pointer list-none">友達 ✓</summary>
          <div className="mt-2">{button("remove", "友達を解除する", "btn-danger")}</div>
        </details>
      );
    default:
      return null;
  }
}

function RelationButton({ userId, op, label, className = "btn-link text-xs" }: { userId: string; op: string; label: string; className?: string }) {
  return (
    <form action={relationAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="op" value={op} />
      <button className={className}>{label}</button>
    </form>
  );
}

export default async function ProfilePage(props: PageProps<"/u/[id]">) {
  const viewer = await requireMember();
  const { id } = await props.params;
  const db = await getDb();
  const profile = await getProfile(db, viewer, id);
  if (!profile) notFound();
  const { posts } = await listFeed(db, viewer, { authorId: profile.id });
  return (
    <div className="grid gap-14 lg:grid-cols-[240px_minmax(0,640px)] lg:gap-20">
      <section className="lg:sticky lg:top-28 lg:self-start">
        <p className="plaque">MEMBER</p>
        <div className="mt-6">
          <Avatar name={profile.displayName} mediaId={profile.avatarMediaId} size={112} />
        </div>
        <h1 className="h1 mt-6 break-words">{profile.displayName}</h1>
        {profile.affiliation && <p className="mt-2 text-sm text-muted">{profile.affiliation}</p>}
        {profile.bio && <p className="mt-6 whitespace-pre-wrap break-words border-t border-line pt-6 text-sm leading-[1.95]">{profile.bio}</p>}
        <dl className="mt-6 border-t border-line pt-6">
          <dt className="plaque">FRIENDS</dt>
          <dd className="mt-1.5 text-2xl font-light tabular-nums">{profile.friendCount}</dd>
        </dl>
        <div className="mt-8">
          {profile.relationship === "self" ? (
            <Link href="/settings" className="btn-ghost">プロフィールを編集</Link>
          ) : profile.blocking ? (
            <div className="space-y-3 border-l-2 border-ink py-1 pl-3">
              <p className="text-sm">ブロック中です。お互いの投稿が見えません。</p>
              <RelationButton userId={profile.id} op="unblock" label="ブロックを解除する" className="btn-ghost" />
            </div>
          ) : (
            <div className="flex flex-wrap gap-3">
              <FriendButton userId={profile.id} rel={profile.relationship} />
              <Link href={`/messages/${profile.id}`} className="btn-ghost">
                メッセージ
              </Link>
            </div>
          )}
        </div>
        {profile.relationship !== "self" && !profile.blocking && (
          <details className="mt-8 text-xs text-muted">
            <summary className="cursor-pointer list-none tracking-[0.08em] hover:text-ink">ミュート・ブロック・通報</summary>
            <div className="mt-3 space-y-5 border border-line bg-light p-4">
              <div className="space-y-1.5">
                {profile.muting ? (
                  <RelationButton userId={profile.id} op="unmute" label="ミュートを解除する" />
                ) : (
                  <RelationButton userId={profile.id} op="mute" label="ミュートする" />
                )}
                <p className="leading-relaxed">ホームにこの人の投稿を出さず、通知も止めます。相手には伝わりません。</p>
              </div>
              <div className="space-y-1.5 border-t border-line pt-4">
                <RelationButton userId={profile.id} op="block" label="ブロックする" className="btn-link text-xs text-danger" />
                <p className="leading-relaxed">お互いの投稿・コメント・プロフィールが見えなくなり、友達も解除されます。相手には伝わりません。</p>
              </div>
              <div className="border-t border-line pt-4">
                <p className="mb-2 tracking-[0.08em]">このメンバーを通報</p>
                <ReportForm targetType="user" targetId={profile.id} />
              </div>
            </div>
          </details>
        )}
      </section>
      <section aria-label="投稿">
        <p className="plaque pb-6">POSTS</p>
        {posts.length === 0 && <p className="border-t border-line py-16 text-center text-sm text-muted">表示できる投稿はありません。</p>}
        {posts.map((p) => (
          <PostCard key={p.id} post={p} />
        ))}
      </section>
    </div>
  );
}

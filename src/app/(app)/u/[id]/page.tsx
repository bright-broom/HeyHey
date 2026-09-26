import Link from "next/link";
import { notFound } from "next/navigation";
import { friendAction } from "@/app/actions/social";
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

export default async function ProfilePage(props: PageProps<"/u/[id]">) {
  const viewer = await requireMember();
  const { id } = await props.params;
  const db = await getDb();
  const profile = await getProfile(db, viewer, id);
  if (!profile) notFound();
  const { posts } = await listFeed(db, viewer, { authorId: profile.id });
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Avatar name={profile.displayName} mediaId={profile.avatarMediaId} size={80} />
          <div className="min-w-0 flex-1">
            <h1 className="h1">{profile.displayName}</h1>
            {profile.affiliation && <p className="text-sm text-muted">{profile.affiliation}</p>}
            <p className="mt-1 text-xs text-muted">友達 {profile.friendCount} 人</p>
          </div>
          <div className="flex items-center gap-2">
            {profile.relationship === "self" ? (
              <Link href="/settings" className="btn-ghost">プロフィールを編集</Link>
            ) : (
              <FriendButton userId={profile.id} rel={profile.relationship} />
            )}
          </div>
        </div>
        {profile.bio && <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed">{profile.bio}</p>}
        {profile.relationship !== "self" && (
          <details className="mt-4 text-xs text-muted">
            <summary className="cursor-pointer list-none hover:underline">このメンバーを通報</summary>
            <div className="mt-2 max-w-xs">
              <ReportForm targetType="user" targetId={profile.id} />
            </div>
          </details>
        )}
      </section>
      <h2 className="h2 px-1">投稿</h2>
      {posts.length === 0 && <p className="card p-6 text-center text-sm text-muted">表示できる投稿はありません。</p>}
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
    </div>
  );
}

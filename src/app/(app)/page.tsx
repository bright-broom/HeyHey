import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { Composer } from "@/components/Composer";
import { PostCard } from "@/components/PostCard";
import { getDb } from "@/server/db/client";
import { listFriends } from "@/server/services/friends";
import { inviteQuotaStatus } from "@/server/services/invites";
import { getProfile } from "@/server/services/members";
import { listFeed } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "ホーム" };

export default async function FeedPage(props: PageProps<"/">) {
  const viewer = await requireMember();
  const sp = await props.searchParams;
  const before = typeof sp.before === "string" ? new Date(sp.before) : null;
  const db = await getDb();
  const [{ posts, nextBefore }, me, friends, quota] = await Promise.all([
    listFeed(db, viewer, { before }),
    getProfile(db, viewer, viewer.id),
    listFriends(db, viewer),
    inviteQuotaStatus(db, viewer),
  ]);

  return (
    <div className="grid gap-14 lg:grid-cols-[minmax(0,640px)_240px] lg:justify-between">
      <div>
        {!before && <Composer name={viewer.displayName} />}
        <section aria-label="フィード" className={before ? "" : "mt-12"}>
          {posts.length === 0 && (
            <div className="border-t border-line py-20 text-center">
              <p className="plaque">EMPTY</p>
              <p className="mt-4 text-sm leading-loose text-muted">
                まだ誰も話していません。
                <br />
                最初のひとことを置いてみてください。
              </p>
            </div>
          )}
          {posts.map((p) => (
            <PostCard key={p.id} post={p} />
          ))}
          {nextBefore && (
            <div className="border-t border-line pt-10 text-center">
              <Link href={`/?before=${encodeURIComponent(nextBefore.toISOString())}`} className="btn-ghost">
                さらに前の投稿
              </Link>
            </div>
          )}
        </section>
      </div>

      {/* 右の余白に置く、静かな案内。いま自分に関係することだけ */}
      <aside className="hidden lg:block">
        <div className="sticky top-28 space-y-10 text-sm">
          {me && (
            <Link href={`/u/${viewer.id}`} className="group flex items-center gap-3">
              <Avatar name={me.displayName} mediaId={me.avatarMediaId} size={44} />
              <span className="min-w-0">
                <span className="block truncate font-medium group-hover:underline">{me.displayName}</span>
                <span className="block truncate text-xs text-muted">{me.affiliation || "所属未設定"}</span>
              </span>
            </Link>
          )}
          <dl className="space-y-5 border-t border-line pt-6">
            <div>
              <dt className="plaque">FRIENDS</dt>
              <dd className="mt-1.5 flex items-baseline justify-between">
                <span className="text-2xl font-light tabular-nums">{friends.friends.length}</span>
                <Link href="/friends" className="btn-link text-xs">
                  {friends.incoming.length ? `申請 ${friends.incoming.length} 件` : "一覧"}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="plaque">INVITES</dt>
              <dd className="mt-1.5 flex items-baseline justify-between">
                <span className="text-2xl font-light tabular-nums">{Number.isFinite(quota.quota) ? quota.remaining : "∞"}</span>
                <Link href="/invites" className="btn-link text-xs">招待する</Link>
              </dd>
            </div>
          </dl>
          <p className="border-t border-line pt-6 text-xs leading-loose text-muted">
            ここでの会話は、承認されたメンバーだけのものです。外への持ち出しはご遠慮ください。
          </p>
        </div>
      </aside>
    </div>
  );
}

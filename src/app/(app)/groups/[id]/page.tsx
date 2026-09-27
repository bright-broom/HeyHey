import Link from "next/link";
import { notFound } from "next/navigation";
import { groupAction } from "@/app/actions/groups";
import { Avatar } from "@/components/Avatar";
import { Composer } from "@/components/Composer";
import { blobEnabled } from "@/server/lib/env";
import { PostCard } from "@/components/PostCard";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { getGroup, listGroupBans, listGroupMembers } from "@/server/services/groups";
import { listFeed } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";
import { GroupForm } from "../GroupForm";

export const metadata = { title: "グループ" };

function Op({ groupId, op, label, userId, className = "btn-link text-xs" }: { groupId: string; op: string; label: string; userId?: string; className?: string }) {
  return (
    <form action={groupAction}>
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="op" value={op} />
      {userId && <input type="hidden" name="userId" value={userId} />}
      <button className={className}>{label}</button>
    </form>
  );
}

const ROLE_LABEL = { owner: "オーナー", moderator: "モデレーター", member: "" } as const;

export default async function GroupPage(props: PageProps<"/groups/[id]">) {
  const viewer = await requireMember();
  const { id } = await props.params;
  const db = await getDb();
  const group = await getGroup(db, viewer, id).catch((e) => {
    if (e instanceof AppError && e.code === "not_found") return null;
    throw e;
  });
  if (!group) notFound();
  const active = group.me?.status === "active";
  const sp = await props.searchParams;
  const before = typeof sp.before === "string" ? new Date(sp.before) : null;
  const [feed, members, bans] = await Promise.all([
    active ? listFeed(db, viewer, { groupId: group.id, before }) : null,
    active || group.adminView ? listGroupMembers(db, viewer, group.id) : null,
    group.canManage ? listGroupBans(db, viewer, group.id) : null,
  ]);

  return (
    <div className="grid gap-14 lg:grid-cols-[minmax(0,640px)_260px] lg:gap-20">
      <div>
        <header className="mb-10 border-b border-line pb-6">
          <p className="plaque">GROUP · {group.joinPolicy === "open" ? "参加自由" : "承認制"}</p>
          <h1 className="h1 mt-2 break-words">{group.name}</h1>
          {group.description && <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted">{group.description}</p>}
          <div className="mt-5 flex flex-wrap items-center gap-4 text-xs text-muted">
            <span className="tabular-nums">{group.memberCount} 人</span>
            {group.archived && <span className="badge text-warn">閉じています（投稿は誰にも見えません）</span>}
            {!group.me && !group.archived && (
              <Op groupId={group.id} op="join" label={group.joinPolicy === "open" ? "参加する" : "参加を申請する"} className="btn-primary" />
            )}
            {group.me?.status === "pending" && (
              <>
                <span>承認待ちです</span>
                <Op groupId={group.id} op="leave" label="申請を取り消す" />
              </>
            )}
            {active && !group.isOwner && <Op groupId={group.id} op="leave" label="退出する" />}
          </div>
        </header>

        {!active && <p className="border-y border-line py-16 text-center text-sm text-muted">投稿はグループのメンバーにだけ表示されます。</p>}
        {group.canPost && (
          <div className="mb-12">
            <Composer name={viewer.displayName} viewerId={viewer.id} uploadMode={blobEnabled() ? "blob" : "disk"} groupId={group.id} groupName={group.name} />
          </div>
        )}
        {feed && feed.posts.length === 0 && <p className="border-t border-line py-16 text-center text-sm text-muted">まだ投稿はありません。</p>}
        {feed?.posts.map((p) => <PostCard key={p.id} post={p} />)}
        {feed?.nextBefore && (
          <div className="py-10 text-center">
            <Link href={`/groups/${group.id}?before=${encodeURIComponent(feed.nextBefore.toISOString())}`} className="btn-ghost">
              さらに読む
            </Link>
          </div>
        )}
      </div>

      {members && (
        <aside className="space-y-12 lg:sticky lg:top-28 lg:self-start">
          {group.canManage && members.pending.length > 0 && (
            <section aria-labelledby="pending">
              <h2 id="pending" className="plaque text-danger">REQUESTS · {members.pending.length}</h2>
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {members.pending.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-3">
                    <Avatar name={m.displayName} mediaId={m.avatarMediaId} size={28} />
                    <Link href={`/u/${m.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                      {m.displayName}
                    </Link>
                    <Op groupId={group.id} op="approve" userId={m.id} label="承認" className="btn-ghost px-2 py-1 text-xs" />
                    <Op groupId={group.id} op="decline" userId={m.id} label="見送る" />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="members">
            <h2 id="members" className="plaque">MEMBERS · {members.active.length}</h2>
            <ul className="mt-3 divide-y divide-line border-y border-line">
              {members.active.map((m) => (
                <li key={m.id} className="py-3">
                  <div className="flex items-center gap-3">
                    <Avatar name={m.displayName} mediaId={m.avatarMediaId} size={28} />
                    <Link href={`/u/${m.id}`} className="min-w-0 flex-1 truncate text-sm hover:underline">
                      {m.displayName}
                    </Link>
                    {ROLE_LABEL[m.role] && <span className="text-[11px] tracking-[0.06em] text-muted">{ROLE_LABEL[m.role]}</span>}
                  </div>
                  {group.adminView && !group.isOwner && m.role !== "owner" && (
                    <div className="mt-1 pl-10">
                      <Op groupId={group.id} op="assign_owner" userId={m.id} label="オーナーに指定（サイト管理者）" />
                    </div>
                  )}
                  {group.canManage && m.id !== viewer.id && m.role !== "owner" && (
                    <details className="mt-1 pl-10 text-xs text-muted">
                      <summary className="cursor-pointer list-none hover:text-ink">管理</summary>
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                        {group.isOwner && m.role === "member" && <Op groupId={group.id} op="moderator" userId={m.id} label="モデレーターにする" />}
                        {group.isOwner && m.role === "moderator" && <Op groupId={group.id} op="member" userId={m.id} label="モデレーターを解く" />}
                        {group.isOwner && <Op groupId={group.id} op="transfer" userId={m.id} label="オーナーを移す" />}
                        {(group.isOwner || m.role === "member") && <Op groupId={group.id} op="remove" userId={m.id} label="グループから外す" className="btn-link text-xs text-danger" />}
                      </div>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {bans && bans.length > 0 && (
            <section aria-labelledby="bans">
              <h2 id="bans" className="plaque">REMOVED · {bans.length}</h2>
              <ul className="mt-3 divide-y divide-line border-y border-line">
                {bans.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 py-3 text-sm">
                    <span className="min-w-0 flex-1 truncate text-muted">{b.displayName}</span>
                    <Op groupId={group.id} op="unban" userId={b.id} label="除外を解除" />
                  </li>
                ))}
              </ul>
              <p className="hint">外した人は、解除するまで参加も申請もできません。</p>
            </section>
          )}
          {group.canManage && (
            <details className="text-sm">
              <summary className="plaque cursor-pointer list-none hover:text-ink">SETTINGS</summary>
              <div className="mt-4">
                <GroupForm group={{ id: group.id, name: group.name, description: group.description, joinPolicy: group.joinPolicy }} />
              </div>
            </details>
          )}
          {group.canArchive && (
            <div className="border-t border-line pt-6 text-xs text-muted">
              {group.archived ? (
                <Op groupId={group.id} op="unarchive" label="グループを再開する" />
              ) : (
                <>
                  <Op groupId={group.id} op="archive" label="グループを閉じる" className="btn-link text-xs text-danger" />
                  <p className="mt-2 leading-relaxed">閉じると、投稿は誰にも見えなくなります（削除はしません）。再開もできます。</p>
                </>
              )}
            </div>
          )}
        </aside>
      )}
    </div>
  );
}

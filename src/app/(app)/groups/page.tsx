import Link from "next/link";
import { groupAction } from "@/app/actions/groups";
import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { listGroups } from "@/server/services/groups";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "グループ" };

type G = Awaited<ReturnType<typeof listGroups>>[number];

function GroupRow({ g }: { g: G }) {
  const status = g.me?.status === "active" ? (g.me.role === "owner" ? "オーナー" : g.me.role === "moderator" ? "モデレーター" : "参加中") : g.me?.status === "pending" ? "承認待ち" : null;
  return (
    <li className="flex flex-wrap items-baseline gap-x-6 gap-y-2 py-5">
      <div className="min-w-0 flex-1">
        <Link href={`/groups/${g.id}`} className="text-[15px] font-medium hover:underline hover:underline-offset-4">
          {g.name}
        </Link>
        {g.archived && <span className="ml-2 badge text-muted">閉じています</span>}
        {g.description && <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted">{g.description}</p>}
      </div>
      <p className="text-xs tabular-nums text-muted">
        {g.memberCount} 人 ／ {g.joinPolicy === "open" ? "参加自由" : "承認制"}
      </p>
      {status ? (
        <span className="text-xs tracking-[0.08em] text-ink-soft">{status}</span>
      ) : (
        <form action={groupAction}>
          <input type="hidden" name="groupId" value={g.id} />
          <input type="hidden" name="op" value="join" />
          <button className="btn-ghost px-3 py-1.5 text-xs">{g.joinPolicy === "open" ? "参加する" : "参加を申請"}</button>
        </form>
      )}
    </li>
  );
}

export default async function GroupsPage() {
  const viewer = await requireMember();
  const all = await listGroups(await getDb(), viewer);
  const mine = all.filter((g) => g.me);
  const others = all.filter((g) => !g.me);
  return (
    <div className="max-w-3xl">
      <PageTitle plaque="GROUPS" title="グループ" lead="テーマごとの小さな集まり。投稿はグループのメンバーにだけ見えます。">
        <Link href="/groups/new" className="btn-primary">グループを作る</Link>
      </PageTitle>
      <section aria-labelledby="mine" className="mb-14">
        <h2 id="mine" className="plaque">MY GROUPS</h2>
        {mine.length ? (
          <ul className="mt-3 divide-y divide-line border-y border-line">{mine.map((g) => <GroupRow key={g.id} g={g} />)}</ul>
        ) : (
          <p className="mt-3 border-y border-line py-10 text-center text-sm text-muted">まだどのグループにも参加していません。</p>
        )}
      </section>
      <section aria-labelledby="others">
        <h2 id="others" className="plaque">ALL GROUPS</h2>
        {others.length ? (
          <ul className="mt-3 divide-y divide-line border-y border-line">{others.map((g) => <GroupRow key={g.id} g={g} />)}</ul>
        ) : (
          <p className="mt-3 border-y border-line py-10 text-center text-sm text-muted">ほかのグループはありません。</p>
        )}
      </section>
    </div>
  );
}

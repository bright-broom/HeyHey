import { PageTitle } from "@/components/PageTitle";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { getDb } from "@/server/db/client";
import { searchMembers } from "@/server/services/members";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "メンバー" };

export default async function MembersPage(props: PageProps<"/members">) {
  const viewer = await requireMember();
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const members = await searchMembers(await getDb(), viewer, q);
  return (
    <div className="max-w-4xl space-y-6">
      <PageTitle bare plaque="MEMBERS" title="メンバー">
        <form className="flex gap-2" role="search">
          <input name="q" defaultValue={q} placeholder="名前・所属で検索" className="input w-60" aria-label="名前・所属で検索" />
          <button className="btn-ghost">検索</button>
        </form>
      </PageTitle>
      {q && <p className="text-xs tracking-[0.06em] text-muted">「{q}」— {members.length} 人</p>}
      <ul className="grid border-t border-line sm:grid-cols-2 sm:gap-x-10">
        {members.map((m) => (
          <li key={m.id}>
            <Link href={`/u/${m.id}`} className="group flex items-center gap-4 border-b border-line py-4">
              <Avatar name={m.displayName} mediaId={m.avatarMediaId} />
              <div className="min-w-0">
                <p className="truncate font-medium group-hover:underline group-hover:underline-offset-4">{m.displayName}</p>
                <p className="truncate text-xs text-muted">{m.affiliation || "所属未設定"}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {members.length === 0 && <p className="py-16 text-center text-sm text-muted">該当するメンバーはいません。</p>}
    </div>
  );
}

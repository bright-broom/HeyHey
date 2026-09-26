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
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="h1">メンバー</h1>
        <form className="flex gap-2">
          <input name="q" defaultValue={q} placeholder="名前・所属で検索" className="input w-60" aria-label="名前・所属で検索" />
          <button className="btn-ghost">検索</button>
        </form>
      </div>
      {q && <p className="text-sm text-muted">「{q}」の検索結果：{members.length} 人</p>}
      <ul className="grid gap-3 sm:grid-cols-2">
        {members.map((m) => (
          <li key={m.id}>
            <Link href={`/u/${m.id}`} className="card flex items-center gap-3 p-3 hover:border-brand">
              <Avatar name={m.displayName} mediaId={m.avatarMediaId} />
              <div className="min-w-0">
                <p className="truncate font-semibold">{m.displayName}</p>
                <p className="truncate text-xs text-muted">{m.affiliation || "所属未設定"}</p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {members.length === 0 && <p className="card p-6 text-center text-sm text-muted">該当するメンバーがいません。</p>}
    </div>
  );
}

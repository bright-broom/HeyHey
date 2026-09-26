import { PageTitle } from "@/components/PageTitle";
import Link from "next/link";
import { ROLE_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/components/labels";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { listUsers } from "@/server/services/admin";
import { requireAdmin } from "@/server/web/session";

export const metadata = { title: "会員管理" };

const FILTERS = ["all", "active", "pending", "suspended", "unverified", "rejected", "withdrawn"] as const;

export default async function AdminMembersPage(props: PageProps<"/admin/members">) {
  const viewer = await requireAdmin();
  const sp = await props.searchParams;
  const q = typeof sp.q === "string" ? sp.q : "";
  const status = typeof sp.status === "string" ? sp.status : "all";
  const rows = await listUsers(await getDb(), viewer, { q, status });
  return (
    <div className="space-y-4">
      <PageTitle bare plaque="MEMBERS" title="会員管理" />
      <form className="flex flex-wrap gap-2">
        <input name="q" defaultValue={q} placeholder="名前・メールで検索" className="input w-60" aria-label="名前・メールで検索" />
        <select name="status" defaultValue={status} className="input w-auto" aria-label="状態">
          {FILTERS.map((f) => (
            <option key={f} value={f}>{f === "all" ? "すべての状態" : STATUS_LABEL[f]}</option>
          ))}
        </select>
        <button className="btn-ghost">絞り込む</button>
      </form>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-line bg-canvas text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">名前</th>
              <th className="px-3 py-2">状態</th>
              <th className="px-3 py-2">権限</th>
              <th className="px-3 py-2">招待者</th>
              <th className="px-3 py-2">最終アクセス</th>
              <th className="px-3 py-2">登録</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((u) => (
              <tr key={u.id} className="hover:bg-canvas/60">
                <td className="px-3 py-2">
                  <Link href={`/admin/members/${u.id}`} className="font-medium hover:underline">{u.displayName}</Link>
                  <div className="text-xs text-muted">{u.email}</div>
                </td>
                <td className="px-3 py-2"><span className={`badge ${STATUS_BADGE[u.status]}`}>{STATUS_LABEL[u.status]}</span></td>
                <td className="px-3 py-2">{ROLE_LABEL[u.role]}</td>
                <td className="px-3 py-2">{u.inviterId ? <Link href={`/admin/members/${u.inviterId}`} className="btn-link">{u.inviterName}</Link> : "—"}</td>
                <td className="px-3 py-2 text-xs">{formatDateTime(u.lastSeenAt)}</td>
                <td className="px-3 py-2 text-xs">{formatDateTime(u.createdAt)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted">該当する会員がいません。</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

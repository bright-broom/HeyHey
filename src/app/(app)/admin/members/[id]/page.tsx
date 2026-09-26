import Link from "next/link";
import { notFound } from "next/navigation";
import { ROLE_LABEL, STATUS_BADGE, STATUS_LABEL } from "@/components/labels";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { getUserForAdmin, inviteLineage } from "@/server/services/admin";
import { mfaEnabled } from "@/server/services/mfa";
import { requireAdmin } from "@/server/web/session";
import { MemberActions } from "./MemberActions";

export const metadata = { title: "会員詳細" };

export default async function AdminMemberPage(props: PageProps<"/admin/members/[id]">) {
  const viewer = await requireAdmin();
  const { id } = await props.params;
  const db = await getDb();
  const u = await getUserForAdmin(db, viewer, id);
  if (!u) notFound();
  const [{ chain, invitees }, targetMfa] = await Promise.all([inviteLineage(db, viewer, id), mfaEnabled(db, u.id)]);
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <section className="card space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="h1">{u.displayName}</h1>
          <span className={`badge ${STATUS_BADGE[u.status]}`}>{STATUS_LABEL[u.status]}</span>
          <span className="badge bg-canvas text-muted">{ROLE_LABEL[u.role]}</span>
        </div>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-muted">メール</dt><dd className="break-all">{u.email}</dd>
          <dt className="text-muted">登録</dt><dd>{formatDateTime(u.createdAt)}</dd>
          <dt className="text-muted">承認</dt><dd>{formatDateTime(u.approvedAt)}</dd>
          <dt className="text-muted">最終アクセス</dt><dd>{formatDateTime(u.lastSeenAt)}</dd>
          {u.suspendedReason && (<><dt className="text-muted">停止理由</dt><dd>{u.suspendedReason}</dd></>)}
        </dl>
        <div>
          <h2 className="h2 mb-2">招待の系譜</h2>
          <ol className="flex flex-wrap items-center gap-1 text-sm">
            {[...chain].reverse().map((c, i) => (
              <li key={c.id} className="flex items-center gap-1">
                {i > 0 && <span className="text-muted">→</span>}
                <Link href={`/admin/members/${c.id}`} className={c.id === u.id ? "font-medium" : "btn-link"}>{c.displayName}</Link>
                {c.status !== "active" && <span className={`badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>}
              </li>
            ))}
          </ol>
          <h3 className="mt-3 text-sm font-medium">この人が招待した人（{invitees.length}）</h3>
          <ul className="mt-1 flex flex-wrap gap-2 text-sm">
            {invitees.map((c) => (
              <li key={c.id}>
                <Link href={`/admin/members/${c.id}`} className="btn-link">{c.displayName}</Link>
                <span className={`ml-1 badge ${STATUS_BADGE[c.status]}`}>{STATUS_LABEL[c.status]}</span>
              </li>
            ))}
            {invitees.length === 0 && <li className="text-muted">なし</li>}
          </ul>
        </div>
      </section>
      <aside className="card p-5">
        <h2 className="h2 mb-3">操作</h2>
        <MemberActions userId={u.id} status={u.status} role={u.role} quota={u.inviteQuotaOverride} viewerIsOwner={viewer.role === "owner"} isSelf={u.id === viewer.id} targetMfa={targetMfa} />
      </aside>
    </div>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { STATUS_BADGE, STATUS_LABEL } from "@/components/labels";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { getCase, REPORT_REASONS, RESOLUTIONS } from "@/server/services/reports";
import { requireAdmin } from "@/server/web/session";
import { ResolveForm } from "./ResolveForm";

export const metadata = { title: "通報の確認" };

export default async function ReportCasePage(props: PageProps<"/admin/reports/[type]/[id]">) {
  const viewer = await requireAdmin();
  const { type, id } = await props.params;
  if (type !== "post" && type !== "comment" && type !== "user") notFound();
  let data;
  try {
    data = await getCase(await getDb(), viewer, type, id);
  } catch (e) {
    if (e instanceof AppError && e.code === "not_found") notFound();
    throw e;
  }
  const { reports, content, author, open } = data;
  const canSuspend = author.role === "member" || (author.role === "admin" && viewer.role === "owner");
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Link href="/admin/reports" className="btn-link">← 通報一覧</Link>
        <section className="card space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="h1">通報された{type === "post" ? "投稿" : type === "comment" ? "コメント" : "会員"}</h1>
            {content?.hidden && <span className="badge bg-warn-soft text-warn">非表示中</span>}
            {content?.visibility === "friends" && <span className="badge bg-canvas text-muted">友達のみ公開</span>}
          </div>
          <p className="text-sm">
            投稿者：<Link href={`/admin/members/${author.id}`} className="btn-link">{author.displayName}</Link>
            <span className={`ml-2 badge ${STATUS_BADGE[author.status]}`}>{STATUS_LABEL[author.status]}</span>
          </p>
          <div className="whitespace-pre-wrap break-words rounded-lg bg-canvas p-4 text-[15px]">{content?.body || "（本文なし）"}</div>
          {content?.mediaIds && content.mediaIds.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {content.mediaIds.map((m) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={m} src={`/api/media/${m}`} alt="" className="w-full rounded-lg" />
              ))}
            </div>
          )}
          <p className="text-xs text-muted">この閲覧は監査ログに記録されました。</p>
        </section>
        <section className="card p-5">
          <h2 className="h2 mb-2">通報（{reports.length} 件）</h2>
          <ul className="divide-y divide-line text-sm">
            {reports.map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{REPORT_REASONS[r.reason]}</span>
                  <span className="text-xs text-muted">{r.reporterName} ・ {formatDateTime(r.createdAt)}</span>
                  {r.status === "resolved" && r.resolution && <span className="badge bg-canvas text-muted">処理済み：{RESOLUTIONS[r.resolution]}</span>}
                </div>
                {r.detail && <p className="mt-1 whitespace-pre-wrap text-muted">{r.detail}</p>}
              </li>
            ))}
          </ul>
        </section>
      </div>
      <aside className="card h-fit p-5">
        <h2 className="h2 mb-3">対応</h2>
        {open ? <ResolveForm targetType={type} targetId={id} canSuspend={canSuspend && author.status === "active"} /> : <p className="text-sm text-muted">この対象の通報はすべて処理済みです。</p>}
      </aside>
    </div>
  );
}

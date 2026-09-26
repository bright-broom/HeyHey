import { PageTitle } from "@/components/PageTitle";
import Link from "next/link";
import { STATUS_LABEL } from "@/components/labels";
import { formatDateTime, timeAgo } from "@/components/time";
import { getDb } from "@/server/db/client";
import { REVIEW_SLA_HOURS } from "@/server/lib/policy";
import { listApplications } from "@/server/services/admin";
import { requireAdmin } from "@/server/web/session";
import { DecisionForm } from "./DecisionForm";

export const metadata = { title: "入会審査" };

export default async function ApplicationsPage(props: PageProps<"/admin/applications">) {
  const viewer = await requireAdmin();
  const sp = await props.searchParams;
  const filter = sp.filter === "decided" ? "decided" : "open";
  const apps = await listApplications(await getDb(), viewer, filter);
  return (
    <div className="space-y-4">
      <PageTitle bare plaque="REVIEW" title="入会審査" lead={filter === "open" ? `申請から ${REVIEW_SLA_HOURS} 時間以内に判断します。` : undefined}>
        <div className="inline-flex border border-line-strong text-xs tracking-[0.08em]">
          <Link href="/admin/applications" className={`px-3 py-2 ${filter === "open" ? "bg-ink text-light" : "text-muted hover:text-ink"}`}>審査待ち</Link>
          <Link href="/admin/applications?filter=decided" className={`px-3 py-2 ${filter === "decided" ? "bg-ink text-light" : "text-muted hover:text-ink"}`}>処理済み</Link>
        </div>
      </PageTitle>
      {apps.length === 0 && <p className="border-y border-line py-16 text-center text-sm text-muted">{filter === "open" ? "審査待ちの申請はありません。" : "処理済みの申請はありません。"}</p>}
      <ul className="space-y-6">
        {apps.map((a) => {
          const overdue = filter === "open" && Date.now() - a.createdAt.getTime() > REVIEW_SLA_HOURS * 3600_000;
          return (
            <li key={a.id} className={`card grid gap-8 p-6 md:grid-cols-[1fr_17rem] ${overdue ? "border-l-2 border-l-danger" : ""}`} data-testid="application">
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-medium tracking-[0.06em]">{a.fullName}</h2>
                  <span className="text-muted">（表示名：{a.displayName}）</span>
                  {a.status === "on_hold" && <span className="badge text-warn">保留中</span>}
                  {a.status === "approved" && <span className="badge text-ok">承認</span>}
                  {a.status === "rejected" && <span className="badge text-danger">却下</span>}
                  {overdue && <span className="badge border-danger bg-danger text-light">{REVIEW_SLA_HOURS} 時間超過</span>}
                </div>
                <dl className="grid grid-cols-[8rem_1fr] gap-y-2">
                  <dt className="text-muted">招待者</dt>
                  <dd>
                    {a.inviterId ? <Link href={`/admin/members/${a.inviterId}`} className="btn-link">{a.inviterName}</Link> : "—"}
                    {a.inviterStatus && a.inviterStatus !== "active" && <span className="ml-2 badge bg-danger-soft text-danger">招待者は現在「{STATUS_LABEL[a.inviterStatus]}」</span>}
                  </dd>
                  <dt className="text-muted">招待者との関係</dt>
                  <dd>{a.relationship}</dd>
                  <dt className="text-muted">所属</dt>
                  <dd>{a.affiliation || "—"}</dd>
                  <dt className="text-muted">メール</dt>
                  <dd className="break-all">{a.email}</dd>
                  <dt className="text-muted">申請</dt>
                  <dd>{formatDateTime(a.createdAt)}（{timeAgo(a.createdAt)}）</dd>
                </dl>
                <p className="whitespace-pre-wrap border-l border-line-strong pl-4 leading-[1.9]">{a.introduction}</p>
                {a.decisionReason && <p className="text-xs text-muted">メモ・理由：{a.decisionReason}</p>}
              </div>
              {filter === "open" ? <DecisionForm applicationId={a.id} /> : <p className="text-xs text-muted">処理日時：{formatDateTime(a.decidedAt)}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

import Link from "next/link";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { listOpenCases, REPORT_REASONS } from "@/server/services/reports";
import { requireAdmin } from "@/server/web/session";

export const metadata = { title: "通報" };

const TYPE_LABEL = { post: "投稿", comment: "コメント", user: "会員" } as const;

export default async function ReportsPage() {
  const viewer = await requireAdmin();
  const cases = await listOpenCases(await getDb(), viewer);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">未処理の通報</h1>
        <p className="mt-1 text-sm text-muted">目標：48 時間以内に確認。内容を開くと、閲覧した記録が監査ログに残ります。</p>
      </div>
      <ul className="card divide-y divide-line">
        {cases.map((c) => (
          <li key={`${c.targetType}:${c.targetId}`}>
            <Link href={`/admin/reports/${c.targetType}/${c.targetId}`} className="flex flex-wrap items-center gap-3 p-3 hover:bg-canvas" data-testid="report-case">
              <span className="badge bg-canvas text-ink">{TYPE_LABEL[c.targetType]}</span>
              <span className="font-semibold">{c.targetUserName}</span>
              <span className="text-sm text-muted">{c.reasons.map((r) => REPORT_REASONS[r as keyof typeof REPORT_REASONS]).join("・")}</span>
              <span className={`badge ml-auto ${c.count >= 3 ? "bg-danger text-white" : "bg-warn-soft text-warn"}`}>{c.count} 件</span>
              <span className="text-xs text-muted">初回 {formatDateTime(c.firstAt)}</span>
            </Link>
          </li>
        ))}
        {cases.length === 0 && <li className="p-8 text-center text-sm text-muted">未処理の通報はありません。</li>}
      </ul>
    </div>
  );
}

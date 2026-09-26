import Link from "next/link";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { REVIEW_SLA_HOURS } from "@/server/lib/policy";
import { dashboard } from "@/server/services/admin";
import { requireAdmin } from "@/server/web/session";

export const metadata = { title: "管理" };

function Stat({ label, value, sub, href, alert }: { label: string; value: string | number; sub?: string; href?: string; alert?: boolean }) {
  const body = (
    <div className={`card h-full p-4 ${alert ? "border-danger/40 bg-danger-soft" : ""}`}>
      <p className="text-xs font-semibold text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${alert ? "text-danger" : ""}`}>{value}</p>
      {sub && <p className="mt-1 text-xs text-muted">{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block hover:opacity-90">{body}</Link> : body;
}

export default async function AdminHome() {
  const viewer = await requireAdmin();
  const s = await dashboard(await getDb(), viewer);
  const oldestHours = s.oldestPendingAt ? (Date.now() - s.oldestPendingAt.getTime()) / 3600_000 : 0;
  const overdue = oldestHours > REVIEW_SLA_HOURS;
  return (
    <div className="space-y-4">
      <h1 className="h1">ダッシュボード</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="審査待ち"
          value={s.pendingApplications}
          sub={s.oldestPendingAt ? `最古 ${formatDateTime(s.oldestPendingAt)}${overdue ? `（${REVIEW_SLA_HOURS} 時間超過）` : ""}` : "なし"}
          href="/admin/applications"
          alert={overdue}
        />
        <Stat label="平均審査時間（30 日）" value={s.avgReviewHours == null ? "—" : `${s.avgReviewHours.toFixed(1)} 時間`} />
        <Stat label="未処理の通報" value={s.openReports} href="/admin/reports" alert={s.openReports > 0} />
        <Stat label="会員数" value={s.activeMembers} href="/admin/members" />
        <Stat label="週次アクティブ会員" value={s.weeklyActiveMembers} sub={s.activeMembers ? `${Math.round((s.weeklyActiveMembers / s.activeMembers) * 100)}%` : undefined} />
        <Stat label="今週の投稿" value={s.postsThisWeek} />
        <Stat label="今週のコメント" value={s.commentsThisWeek} />
        <Stat label="今週の招待発行" value={s.invitesThisWeek} />
      </div>
    </div>
  );
}

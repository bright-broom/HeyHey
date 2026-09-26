import { PageTitle } from "@/components/PageTitle";
import Link from "next/link";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { isOwner, REVIEW_SLA_HOURS } from "@/server/lib/policy";
import { dashboard } from "@/server/services/admin";
import { releaseChecks } from "@/server/services/readiness";
import { requireAdmin } from "@/server/web/session";

export const metadata = { title: "管理" };

/** 数字は銘板のように、細く大きく。上の線が墨なら通常、煉瓦色なら要対応 */
function Stat({ label, value, sub, href, alert }: { label: string; value: string | number; sub?: string; href?: string; alert?: boolean }) {
  const body = (
    <div className={`h-full border-t pt-4 ${alert ? "border-danger" : "border-ink"}`}>
      <p className={`text-xs tracking-[0.08em] ${alert ? "text-danger" : "text-muted"}`}>{label}</p>
      <p className={`mt-4 text-4xl font-light tabular-nums tracking-tight ${alert ? "text-danger" : ""}`}>{value}</p>
      {sub && <p className="mt-2 text-xs leading-relaxed text-muted">{sub}</p>}
    </div>
  );
  return href ? <Link href={href} className="block transition-opacity hover:opacity-70">{body}</Link> : body;
}

export default async function AdminHome() {
  const viewer = await requireAdmin();
  const db = await getDb();
  const [s, checks] = await Promise.all([dashboard(db, viewer), isOwner(viewer) ? releaseChecks(db, viewer) : null]);
  const oldestHours = s.oldestPendingAt ? (Date.now() - s.oldestPendingAt.getTime()) / 3600_000 : 0;
  const overdue = oldestHours > REVIEW_SLA_HOURS;
  return (
    <div>
      <PageTitle bare plaque="OVERVIEW" title="ダッシュボード" />
      <div className="grid grid-cols-2 gap-x-8 gap-y-12 md:grid-cols-4">
        <Stat
          label="審査待ち"
          value={s.pendingApplications}
          sub={s.oldestPendingAt ? `最古 ${formatDateTime(s.oldestPendingAt)}${overdue ? `（${REVIEW_SLA_HOURS} 時間超過）` : ""}` : "なし"}
          href="/admin/applications"
          alert={overdue}
        />
        <Stat label="平均審査時間（30 日）" value={s.avgReviewHours == null ? "—" : `${s.avgReviewHours.toFixed(1)}h`} />
        <Stat label="未処理の通報" value={s.openReports} href="/admin/reports" alert={s.openReports > 0} />
        <Stat label="会員数" value={s.activeMembers} href="/admin/members" />
        <Stat label="週次アクティブ会員" value={s.weeklyActiveMembers} sub={s.activeMembers ? `${Math.round((s.weeklyActiveMembers / s.activeMembers) * 100)}%` : undefined} />
        <Stat label="今週の投稿" value={s.postsThisWeek} />
        <Stat label="今週のコメント" value={s.commentsThisWeek} />
        <Stat label="今週の招待発行" value={s.invitesThisWeek} />
      </div>
      {checks && <ReleaseChecks checks={checks} />}
    </div>
  );
}

/** オーナーだけに見せる、本番を開く前の設定確認 */
function ReleaseChecks({ checks }: { checks: Awaited<ReturnType<typeof releaseChecks>> }) {
  const done = checks.filter((c) => c.ok).length;
  return (
    <section aria-labelledby="readiness-title" className="mt-20">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="plaque">RELEASE CHECK · OWNER ONLY</p>
          <h2 id="readiness-title" className="h2 mt-2">リリース前チェック</h2>
        </div>
        <p className="text-sm tabular-nums text-muted">
          {done} / {checks.length} 完了
        </p>
      </div>
      <ul className="divide-y divide-line border-b border-line">
        {checks.map((c) => (
          <li key={c.id} className="grid gap-1 py-4 sm:grid-cols-[1.5rem_16rem_1fr] sm:gap-4" data-testid="readiness" data-ok={c.ok}>
            <span aria-hidden className={`mt-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full border text-[10px] ${c.ok ? "border-ok bg-ok text-light" : "border-danger text-danger"}`}>
              {c.ok ? "✓" : "!"}
            </span>
            <p className="text-sm">
              <span className="sr-only">{c.ok ? "完了：" : "未完了："}</span>
              {c.label}
            </p>
            <div className="text-xs leading-relaxed text-muted">
              <p>{c.detail}</p>
              {!c.ok && <p className="mt-1 text-ink-soft">対応：{c.fix}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

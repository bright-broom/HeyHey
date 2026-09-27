import { PageTitle } from "@/components/PageTitle";
import Link from "next/link";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { isOwner, PHASE3_WEEKLY_ACTIVE_RATE, REVIEW_SLA_HOURS } from "@/server/lib/policy";
import { weeklyActivityTrend, type WeeklyActivity } from "@/server/services/activity";
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
  const [s, trend, checks] = await Promise.all([dashboard(db, viewer), weeklyActivityTrend(db, viewer), isOwner(viewer) ? releaseChecks(db, viewer) : null]);
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
        <Stat label="週次アクティブ会員" value={s.weeklyActiveMembers} sub={s.activeMembers ? `${Math.round((s.weeklyActiveMembers / s.activeMembers) * 100)}%（目標 ${pct(PHASE3_WEEKLY_ACTIVE_RATE)}）` : undefined} />
        <Stat label="今週の投稿" value={s.postsThisWeek} />
        <Stat label="今週のコメント" value={s.commentsThisWeek} />
        <Stat label="今週の招待発行" value={s.invitesThisWeek} />
      </div>
      <ActivityTrend trend={trend} />
      {checks && <ReleaseChecks checks={checks} />}
    </div>
  );
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/**
 * 週次アクティブ率の推移（毎日の定期処理が残した記録から、週ごとに 1 つ）。
 * Phase 3 に進むかは、この率が目標を続けて超えているかで判断する。
 */
function ActivityTrend({ trend }: { trend: WeeklyActivity[] }) {
  let streak = 0;
  for (let i = trend.length - 1; i >= 0 && trend[i]!.reached; i--) streak++;
  return (
    <section aria-labelledby="activity-title" className="mt-20">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <p className="plaque">WEEKLY ACTIVE · PHASE GATE</p>
          <h2 id="activity-title" className="h2 mt-2">週次アクティブ率の推移</h2>
        </div>
        <p className="text-sm text-muted" data-testid="activity-streak">
          目標 {pct(PHASE3_WEEKLY_ACTIVE_RATE)} 以上：{streak ? `直近 ${streak} 週続けて達成` : "未達"}
        </p>
      </div>
      {trend.length === 0 ? (
        <p className="border-b border-line py-6 text-sm text-muted">まだ記録がありません。毎日の定期処理が、その日の数字を 1 行ずつ残します。</p>
      ) : (
        <table className="w-full border-b border-line text-sm">
          <caption className="sr-only">週ごとの週次アクティブ率（各週の最後に記録した日の、直近 7 日の数字）</caption>
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="py-3 font-normal">記録日</th>
              <th scope="col" className="py-3 text-right font-normal">アクティブ ／ 会員</th>
              <th scope="col" className="w-1/2 py-3 pl-6 font-normal">率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {trend.map((w) => (
              <tr key={w.day} data-testid="activity-week" data-reached={w.reached}>
                <td className="py-3 tabular-nums">{shortDay(w.day)}</td>
                <td className="py-3 text-right tabular-nums">
                  {w.weeklyActiveMembers} ／ {w.activeMembers}
                </td>
                <td className="py-3 pl-6">
                  <div className="flex items-center gap-3">
                    <div className="relative h-2 flex-1 bg-line" aria-hidden>
                      <div className={`absolute inset-y-0 left-0 ${w.reached ? "bg-ok" : "bg-ink"}`} style={{ width: `${Math.min(100, (w.rate ?? 0) * 100)}%` }} />
                      <div className="absolute inset-y-[-3px] w-px bg-danger" style={{ left: pct(PHASE3_WEEKLY_ACTIVE_RATE) }} />
                    </div>
                    <span className="w-20 text-right tabular-nums">
                      {w.rate == null ? "—" : pct(w.rate)}
                      {w.reached && <span className="ml-1 text-xs text-ok">達成</span>}
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
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

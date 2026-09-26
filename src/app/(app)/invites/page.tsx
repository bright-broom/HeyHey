import { PageTitle } from "@/components/PageTitle";
import { revokeInviteAction } from "@/app/actions/social";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { isAdmin } from "@/server/lib/policy";
import { inviteQuotaStatus, listMyInvitations } from "@/server/services/invites";
import { requireMember } from "@/server/web/session";
import { InviteForm } from "./InviteForm";

export const metadata = { title: "招待" };

function statusOf(i: { revokedAt: Date | null; expiresAt: Date; useCount: number; maxUses: number }) {
  if (i.revokedAt) return { label: "取り消し済み", cls: "text-muted", active: false };
  if (i.useCount >= i.maxUses) return { label: "使用済み", cls: "text-ok", active: false };
  if (i.expiresAt <= new Date()) return { label: "期限切れ", cls: "text-muted", active: false };
  return { label: "有効", cls: "text-ink", active: true };
}

export default async function InvitesPage() {
  const viewer = await requireMember();
  const db = await getDb();
  const [quota, invites] = await Promise.all([inviteQuotaStatus(db, viewer), listMyInvitations(db, viewer)]);
  const admin = isAdmin(viewer);
  return (
    <div className="max-w-3xl space-y-12">
      <PageTitle
        plaque="INVITE"
        title="招待"
        lead="招待リンクから申請した人は、管理者の審査を経て参加できます。誰が誰を招待したかは記録されます。"
      />
      <section className="card space-y-6 p-6 sm:p-8">
        <div className="flex items-center justify-between">
          <h2 className="h2">新しい招待リンク</h2>
          <span className="text-xs tracking-[0.06em] text-muted" data-testid="quota">
            {Number.isFinite(quota.quota) ? (
              <>
                残り <span className="text-lg font-light tabular-nums text-ink">{quota.remaining}</span> / {quota.quota} 件（30 日あたり）
              </>
            ) : (
              "管理者：無制限"
            )}
          </span>
        </div>
        <InviteForm admin={admin} disabled={quota.remaining <= 0} />
        <p className="hint">リンクの有効期限は 7 日、1 回だけ使えます。</p>
      </section>
      <section className="space-y-3">
        <h2 className="h2">発行した招待</h2>
        <ul className="divide-y divide-line border-y border-line">
          {invites.map((i) => {
            const s = statusOf(i);
            return (
              <li key={i.id} className="flex flex-wrap items-center gap-4 py-4 text-sm">
                <span className={`badge ${s.cls}`}>{s.label}</span>
                <span className="min-w-0 flex-1 truncate">{i.note || "（メモなし）"}</span>
                <span className="text-xs text-muted">
                  {i.useCount}/{i.maxUses} 回 ・ 期限 {formatDateTime(i.expiresAt)}
                </span>
                {s.active && (
                  <form action={revokeInviteAction}>
                    <input type="hidden" name="invitationId" value={i.id} />
                    <button className="btn-link text-danger">取り消す</button>
                  </form>
                )}
              </li>
            );
          })}
          {invites.length === 0 && <li className="py-10 text-center text-sm text-muted">まだ誰も招待していません。</li>}
        </ul>
      </section>
    </div>
  );
}

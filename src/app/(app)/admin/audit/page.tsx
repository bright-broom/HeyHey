import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { listAuditLogs } from "@/server/services/admin";
import { requireAdmin } from "@/server/web/session";

export const metadata = { title: "監査ログ" };

const ACTION_LABEL: Record<string, string> = {
  "user.register": "入会申請",
  "user.accept_terms": "規約同意",
  "user.suspend": "利用停止",
  "user.reinstate": "利用再開",
  "user.set_role": "権限変更",
  "user.set_invite_quota": "招待枠変更",
  "user.withdraw": "退会",
  "application.approve": "申請を承認",
  "application.reject": "申請を却下",
  "application.hold": "申請を保留",
  "invite.create": "招待リンク発行",
  "invite.revoke": "招待リンク取り消し",
  "post.auto_hide": "投稿を自動非表示",
  "comment.auto_hide": "コメントを自動非表示",
  "report.view_content": "通報内容を閲覧",
  "report.resolve": "通報を処理",
};

export default async function AuditPage() {
  const viewer = await requireAdmin();
  const logs = await listAuditLogs(await getDb(), viewer);
  return (
    <div className="space-y-4">
      <div>
        <h1 className="h1">監査ログ</h1>
        <p className="mt-1 text-sm text-muted">承認・停止・権限変更・通報の処理などを記録しています。このログは誰も書き換え・削除できません（最新 200 件）。</p>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-line bg-canvas text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2">日時</th>
              <th className="px-3 py-2">操作者</th>
              <th className="px-3 py-2">操作</th>
              <th className="px-3 py-2">対象</th>
              <th className="px-3 py-2">理由・詳細</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {logs.map((l) => (
              <tr key={l.id}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{formatDateTime(l.createdAt)}</td>
                <td className="px-3 py-2">{l.actorName ?? "システム"}</td>
                <td className="px-3 py-2 font-medium">{ACTION_LABEL[l.action] ?? l.action}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{l.targetType}:{l.targetId?.slice(0, 8)}</td>
                <td className="px-3 py-2 text-xs">
                  {l.reason}
                  {Object.keys(l.meta ?? {}).length > 0 && <span className="ml-1 text-muted">{JSON.stringify(l.meta)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

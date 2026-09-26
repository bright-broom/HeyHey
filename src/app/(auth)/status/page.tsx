import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { logoutAction } from "@/app/actions/auth";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { myApplication } from "@/server/services/members";
import { getViewer, homeFor } from "@/server/web/session";
import { ResendForm } from "./ResendForm";

export const metadata = { title: "申請状況" };

/** 申請者が見られる唯一の画面。自分の申請内容以外の情報は一切出さない */
export default async function StatusPage() {
  const v = await getViewer();
  if (!v || (v.status !== "unverified" && v.status !== "pending")) redirect(homeFor(v));
  const db = await getDb();
  const app = await myApplication(db, v.id);
  const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, v.id));
  const steps = [
    { label: "申請を送信", done: true },
    { label: "メールアドレスの確認", done: v.status === "pending" },
    { label: "管理者の審査", done: false, current: v.status === "pending" },
  ];
  return (
    <div className="card space-y-5 p-6">
      <div>
        <h1 className="h1">申請状況</h1>
        <p className="mt-1 text-sm text-muted">承認されるまで、コミュニティの内容は表示されません。</p>
      </div>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-3 text-sm">
            <span
              className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                s.done ? "bg-ok text-white" : s.current ? "bg-brand text-white" : "bg-canvas text-muted"
              }`}
            >
              {s.done ? "✓" : i + 1}
            </span>
            <span className={s.current ? "font-semibold" : ""}>{s.label}{s.current && "（審査中）"}</span>
          </li>
        ))}
      </ol>
      {v.status === "unverified" && me && (
        <div className="space-y-2 rounded-lg bg-warn-soft p-3 text-sm text-warn">
          <p>{me.email} 宛の確認メールのリンクを開いてください。</p>
          <ResendForm email={me.email} />
        </div>
      )}
      {v.status === "pending" && app?.status === "on_hold" && (
        <p className="rounded-lg bg-brand-soft p-3 text-sm text-brand">管理者が確認を進めています。追加で連絡が入る場合があります。</p>
      )}
      {app && (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-2 border-t border-line pt-4 text-sm">
          <dt className="text-muted">申請日時</dt>
          <dd>{formatDateTime(app.createdAt)}</dd>
          <dt className="text-muted">氏名</dt>
          <dd>{app.fullName}</dd>
          <dt className="text-muted">招待者との関係</dt>
          <dd>{app.relationship}</dd>
        </dl>
      )}
      <form action={logoutAction}>
        <button className="btn-link">ログアウト</button>
      </form>
    </div>
  );
}

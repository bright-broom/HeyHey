import { notFound } from "next/navigation";
import { desc } from "drizzle-orm";
import { getDb } from "@/server/db/client";
import { mailOutbox } from "@/server/db/schema";
import { formatDateTime } from "@/components/time";

export const metadata = { title: "開発用メールボックス" };

/**
 * ローカル開発・E2E 専用。メール送信サービスを設定していないとき、送ったはずのメールをここで見る。
 * 本番では ENABLE_DEV_MAILBOX を設定しない限り 404 になる。
 */
export default async function DevMailPage() {
  const enabled = process.env.NODE_ENV !== "production" || process.env.ENABLE_DEV_MAILBOX === "1";
  // 本番 URL（https）では有効化フラグがあっても開かない
  if (!enabled || process.env.RESEND_API_KEY || (process.env.APP_URL ?? "").startsWith("https://")) notFound();
  const mails = await (await getDb()).select().from(mailOutbox).orderBy(desc(mailOutbox.createdAt)).limit(30);
  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">開発用メールボックス（本番では無効）</p>
      {mails.map((m) => (
        <article key={m.id} className="card space-y-1 p-4 text-sm" data-testid="mail" data-to={m.to}>
          <div className="text-xs text-muted">{formatDateTime(m.createdAt)} ・ 宛先 {m.to}</div>
          <h2 className="font-bold">{m.subject}</h2>
          <pre className="whitespace-pre-wrap break-all font-sans">{m.body}</pre>
        </article>
      ))}
      {mails.length === 0 && <p className="text-sm text-muted">まだメールはありません。</p>}
    </div>
  );
}

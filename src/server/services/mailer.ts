import type { DbOrTx } from "../db/client";
import { mailOutbox } from "../db/schema";
import { appBaseUrl } from "../lib/env";

export type Mail = { to: string; subject: string; body: string; headers?: Record<string, string> };

/**
 * メール送信。RESEND_API_KEY があれば Resend で送り、なければ送信箱（mail_outbox）に
 * 保存してサーバーログに出すだけにする（ローカル開発・テスト用）。
 */
export async function sendMail(db: DbOrTx, mail: Mail): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM ?? "Kakomi <no-reply@example.com>";
  if (key) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: mail.to, subject: mail.subject, text: mail.body, ...(mail.headers ? { headers: mail.headers } : {}) }),
    });
    if (!res.ok) throw new Error(`mail send failed: ${res.status}`);
    await db.insert(mailOutbox).values({ to: mail.to, subject: mail.subject, body: "(sent via resend)", provider: "resend" });
    return;
  }
  await db.insert(mailOutbox).values({ to: mail.to, subject: mail.subject, body: mail.body, provider: "outbox" });
  if (process.env.NODE_ENV !== "test") console.info(`[mail] to=${mail.to} subject=${mail.subject}\n${mail.body}`);
}

export function appUrl(path: string): string {
  return `${appBaseUrl()}${path}`;
}

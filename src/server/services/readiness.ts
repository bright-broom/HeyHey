import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditLogs, userMfa, users } from "../db/schema";
import { isHttps } from "../lib/env";
import { operatorInfo } from "../lib/operator";
import { assertAdmin } from "../lib/policy";
import type { Viewer } from "../lib/viewer";

/**
 * リリース前チェック（管理者向け）。本番を実際のメンバーに開く前に、運用に必要な設定が
 * そろっているかを 1 画面で確かめる。秘密の値そのものは出さず、設定の有無だけを見る。
 */
export type ReadinessCheck = { id: string; label: string; ok: boolean; detail: string; fix: string };

const DAY = 24 * 60 * 60 * 1000;

export async function releaseChecks(db: Db, viewer: Viewer, now = new Date()): Promise<ReadinessCheck[]> {
  assertAdmin(viewer);
  const env = process.env;
  const op = operatorInfo();

  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userMfa, eq(userMfa.userId, users.id))
    .where(and(eq(users.status, "active"), inArray(users.role, ["admin", "owner"])));
  const [lastRun] = await db
    .select({ at: auditLogs.createdAt })
    .from(auditLogs)
    .where(eq(auditLogs.action, "system.maintenance"))
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);

  return [
    {
      id: "https",
      label: "HTTPS で公開",
      ok: isHttps(),
      detail: isHttps() ? "Cookie は Secure・__Host- 付きで発行されています。" : "http で動いています。",
      fix: "Vercel にデプロイするか、APP_URL を https の URL にする。",
    },
    {
      id: "mail",
      label: "メール送信",
      ok: !!env.RESEND_API_KEY && !!env.MAIL_FROM,
      detail: env.RESEND_API_KEY ? (env.MAIL_FROM ? "Resend で送信します。" : "送信元（MAIL_FROM）が未設定です。") : "送信されず、送信箱に溜まるだけです。",
      fix: "RESEND_API_KEY と MAIL_FROM を設定する（送信元ドメインの認証が必要）。",
    },
    {
      id: "email_verification",
      label: "メールアドレスの確認",
      ok: env.EMAIL_VERIFICATION !== "off",
      detail: env.EMAIL_VERIFICATION === "off" ? "確認を省いています（招待リンクと承認だけで入会）。" : "申請時にメールアドレスを確認します。",
      fix: "メール送信を設定してから、EMAIL_VERIFICATION を削除して再デプロイする。",
    },
    {
      id: "mfa_key",
      label: "2 段階認証の暗号鍵",
      ok: !!env.MFA_ENCRYPTION_KEY,
      detail: env.MFA_ENCRYPTION_KEY ? "設定済みです。DB とは別の場所に控えてあることを確認してください。" : "未設定です（本番では 2 段階認証を設定できません）。",
      fix: "openssl rand -base64 32 で作った値を MFA_ENCRYPTION_KEY に設定する。",
    },
    {
      id: "admins",
      label: "2 段階認証を済ませた管理者が 2 人以上",
      ok: admins.length >= 2,
      detail: `いま ${admins.length} 人です。1 人に権限が集中しないようにします。`,
      fix: "会員に 2 段階認証を設定してもらい、会員管理から管理者に任命し、設定チケットを渡す。",
    },
    {
      id: "cron",
      label: "毎日の定期処理",
      ok: !!env.CRON_SECRET && !!lastRun && now.getTime() - lastRun.at.getTime() < 2 * DAY,
      detail: !env.CRON_SECRET
        ? "CRON_SECRET が未設定のため、定期処理が動きません。"
        : lastRun
          ? `最後の実行：${lastRun.at.toISOString().slice(0, 16).replace("T", " ")}（UTC）`
          : "まだ一度も実行されていません（毎日 3:00 JST に実行）。",
      fix: "CRON_SECRET を設定して再デプロイする（退会者データの消去、審査の再通知、期限切れデータの片付け）。",
    },
    {
      id: "operator",
      label: "運営者名と問い合わせ先",
      ok: !!op.name && !!op.contactEmail,
      detail: op.name && op.contactEmail ? `${op.name} ／ ${op.contactEmail}` : "利用規約とプライバシーポリシーに「未設定」と表示されています。",
      fix: "OPERATOR_NAME と CONTACT_EMAIL を設定し、規約とポリシーの本文を専門家に確認してもらう。",
    },
  ];
}

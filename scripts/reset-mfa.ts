/**
 * 2 段階認証の解除（運営者用）。スマートフォンもリカバリーコードも失った会員の救済に使う。
 *   npm run mfa:reset -- someone@example.com "本人から電話で依頼。社員証で本人確認済み"
 *
 * 本人確認は運営者が画面の外で行うこと。解除すると全端末からログアウトされ、監査ログに残る。
 * 管理者を解除した場合、本人が設定し直すまで管理機能は使えない。
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { resetMfaByOperator } from "../src/server/services/mfa";

async function main() {
  const [email, reason] = process.argv.slice(2);
  if (!email || !reason) {
    console.error('使い方: npm run mfa:reset -- <メールアドレス> "<理由と本人確認の方法>"');
    process.exit(1);
  }
  const db = await getDb();
  const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!u) {
    console.error("該当する会員がいません");
    process.exit(1);
  }
  await resetMfaByOperator(db, u.id, reason);
  console.log(`✓ ${email}（${u.role}）の 2 段階認証を解除し、全端末からログアウトさせました`);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

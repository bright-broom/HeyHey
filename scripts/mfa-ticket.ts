/**
 * 管理者以上が 2 段階認証を設定するための、1 回限りの設定チケットを発行する（運営者用）。
 *   npm run mfa:ticket -- owner@example.com
 *
 * パスワードだけが漏れた管理者アカウントで、攻撃者が先に 2 段階認証を設定することを防ぐため、
 * DB に直接つなげる運営者だけが発行できる。本人には画面の外（対面・電話など）で渡すこと。
 * 標準出力にはチケットだけを出す（スクリプトから使えるように）。案内は標準エラーに出す。
 */
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "../src/server/db/client";
import { users } from "../src/server/db/schema";
import { ENROLL_TICKET_TTL_MIN, issueEnrollmentTicket } from "../src/server/services/mfa";

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error("使い方: npm run mfa:ticket -- <メールアドレス>");
    process.exit(1);
  }
  const db = await getDb();
  const [u] = await db.select({ id: users.id, role: users.role }).from(users).where(eq(users.email, email.trim().toLowerCase()));
  if (!u) {
    console.error("該当する会員がいません");
    process.exit(1);
  }
  if (u.role === "member") console.error("注意：一般会員はチケットなしで設定できます。管理者に任命する前に本人に設定してもらってください。");
  const { ticket } = await issueEnrollmentTicket(db, u.id);
  console.error(`✓ ${email}（${u.role}）の設定チケットを発行しました（${ENROLL_TICKET_TTL_MIN} 分有効・1 回限り）`);
  console.log(ticket);
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/**
 * 毎日の定期処理を手元から流す（本番は Vercel Cron が毎日 3:00 JST に /api/cron/daily を呼ぶ）。
 *   npm run maintenance
 */
import { closeDb, getDb } from "../src/server/db/client";
import { runDailyMaintenance } from "../src/server/services/maintenance";

async function main() {
  const report = await runDailyMaintenance(await getDb());
  console.log("✓ 定期処理を実行しました");
  console.log(JSON.stringify(report, null, 2));
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

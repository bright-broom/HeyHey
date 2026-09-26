/**
 * マイグレーション適用。
 * - DATABASE_URL あり：PostgreSQL（Supabase / Neon など）に適用
 * - なし：ローカルの PGlite（.data/pglite）に適用（アプリ起動時にも自動適用される）
 */
import path from "node:path";
import { closeDb, getDb } from "../src/server/db/client";

async function main() {
  // マイグレーションは接続プーラーを通さない直結 URL で流す（Neon / Supabase の推奨）
  if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  if (process.env.DATABASE_URL) {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const db = await getDb();
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  } else {
    await getDb(); // PGlite は接続時に自動で適用
  }
  await closeDb();
  console.log("✓ マイグレーションを適用しました");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import "server-only";
import path from "node:path";
import fs from "node:fs";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * DB 接続は 1 か所に集約する。
 * - DATABASE_URL があれば PostgreSQL（Supabase / Neon / RDS など）に node-postgres で接続
 * - なければ PGlite（WASM 版 PostgreSQL）を .data/pglite に置いてゼロ設定で動かす
 *   テストでは PGLITE_DIR=memory:// でプロセス内の使い捨て DB になる
 * どちらも同じ PostgreSQL 方言・同じスキーマ・同じマイグレーションを使う。
 */
export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

type Holder = { db?: Promise<Db>; close?: () => Promise<void> };
const g = globalThis as unknown as { __kakomiDb?: Holder };
const holder: Holder = (g.__kakomiDb ??= {});

const MIGRATIONS_DIR = path.join(/*turbopackIgnore: true*/ process.cwd(), "drizzle");

async function open(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
    holder.close = () => pool.end();
    return drizzle(pool, { schema });
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const dir = process.env.PGLITE_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "pglite");
  if (!dir.startsWith("memory://")) fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  // PGlite はローカル専用なので、起動時にマイグレーションを自動適用して手順を 1 つ減らす
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  holder.close = () => client.close();
  return db as unknown as Db;
}

export function getDb(): Promise<Db> {
  holder.db ??= open().catch((e) => {
    holder.db = undefined;
    throw e;
  });
  return holder.db;
}

export async function closeDb(): Promise<void> {
  if (holder.close) await holder.close();
  holder.db = undefined;
  holder.close = undefined;
}

export { schema };

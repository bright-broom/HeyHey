import "server-only";
import path from "node:path";
import fs from "node:fs";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { databaseUrl } from "../lib/env";
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
  const url = databaseUrl();
  if (!url && process.env.DATABASE_URL) {
    console.warn("[db] 開発サーバーでは .env.local のリモート DB を使わず、ローカルの PGlite を使います（ALLOW_REMOTE_IN_DEV=1 で変更可）");
  }
  if (url) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const onVercel = !!process.env.VERCEL;
    const pool = new Pool({
      connectionString: url,
      // Vercel（Fluid compute）はインスタンスが並列に増えるので、1 インスタンスあたりの接続は少なく
      max: Number(process.env.DB_POOL_MAX ?? (onVercel ? 5 : 10)),
      idleTimeoutMillis: onVercel ? 5_000 : 30_000,
    });
    if (onVercel) {
      // インスタンスが休止する前にアイドル接続を確実に閉じる（接続リーク防止）
      const { attachDatabasePool } = await import("@vercel/functions");
      attachDatabasePool(pool);
    }
    holder.close = () => pool.end();
    return drizzle(pool, { schema });
  }
  if (process.env.VERCEL) {
    // サーバーレスでは PGlite のファイルが永続しない。設定漏れで「データが消える本番」にならないよう止める
    throw new Error("DATABASE_URL が設定されていません（Vercel では PostgreSQL が必須です）");
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blobEnabled, databaseUrl } from "@/server/lib/env";

const KEYS = ["NODE_ENV", "DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "ALLOW_REMOTE_IN_DEV"] as const;
let saved: Record<string, string | undefined> = {};
const set = (o: Partial<Record<(typeof KEYS)[number], string>>) => Object.assign(process.env, o);
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) if (k !== "NODE_ENV") delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});

describe("開発サーバーから本番のリソースにつながない", () => {
  const PROD = "postgres://user:pw@ep-example-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require";

  it("next dev では、.env.local に入ったリモートの DB と Blob を使わない", () => {
    set({ NODE_ENV: "development", DATABASE_URL: PROD, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_example" });
    expect(databaseUrl()).toBeUndefined();
    expect(blobEnabled()).toBe(false);
  });

  it("手元の PostgreSQL（localhost）には、開発サーバーからもつなぐ", () => {
    set({ NODE_ENV: "development", DATABASE_URL: "postgres://postgres@localhost:5432/kakomi" });
    expect(databaseUrl()).toBe("postgres://postgres@localhost:5432/kakomi");
  });

  it("ALLOW_REMOTE_IN_DEV=1 を付けたときだけ、開発サーバーからリモートにつなぐ", () => {
    set({ NODE_ENV: "development", DATABASE_URL: PROD, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_example", ALLOW_REMOTE_IN_DEV: "1" });
    expect(databaseUrl()).toBe(PROD);
    expect(blobEnabled()).toBe(true);
  });

  it("本番（production）とテストでは、設定どおりにつなぐ", () => {
    for (const NODE_ENV of ["production", "test"]) {
      set({ NODE_ENV, DATABASE_URL: PROD, BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_example" });
      expect(databaseUrl()).toBe(PROD);
      expect(blobEnabled()).toBe(true);
    }
  });
});

import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.mts";

/**
 * 本番と同じ node-postgres 経由で、実際の PostgreSQL に対して同じテストを流す。
 *   TEST_DATABASE_URL=postgres://... npm run test:pg
 * （テスト用の空の DB を指定すること。データは消さないが大量に作る）
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { PGLITE_DIR: "", DATABASE_URL: process.env.TEST_DATABASE_URL ?? "", MFA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") },
      fileParallelism: false,
    },
  }),
);

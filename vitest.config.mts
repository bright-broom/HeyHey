import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "server-only": path.resolve(import.meta.dirname, "tests/server-only-stub.ts") } },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
    env: { PGLITE_DIR: "memory://", UPLOAD_DIR: ".data/test-uploads", NODE_ENV: "test" },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});

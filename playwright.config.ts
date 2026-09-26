import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";

const PORT = 3200;
// クラウド環境などで Playwright 同梱の Chromium と版が合わないときは、既存の Chromium を使う
const localChromium = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => fs.existsSync(p));

/**
 * next start は .env.production.local などを読み込むので、`vercel env pull` した本番の値
 * （DATABASE_URL・BLOB_READ_WRITE_TOKEN・VERCEL=1 など）がそのままテストに入り、本番の DB に
 * つながってしまう。.env ファイルにあるキーはすべて空で上書きし、テストに本番の値を 1 つも渡さない
 * （Next は、すでに環境変数にあるキーを .env ファイルで上書きしない）。
 */
const envFileKeys = fs
  .readdirSync(".")
  .filter((f) => /^\.env(\..+)?$/.test(f) && f !== ".env.example")
  .flatMap((f) => fs.readFileSync(f, "utf8").split("\n"))
  .map((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
  .filter((k): k is string => !!k);
const blanked = Object.fromEntries(envFileKeys.map((k) => [k, ""]));

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    locale: "ja-JP",
    trace: "retain-on-failure",
    launchOptions: localChromium ? { executablePath: localChromium } : {},
  },
  webServer: {
    // 本番ビルドを、使い捨ての DB で起動する（先に npm run build が必要）
    // オーナーの 2 段階認証の設定チケットも発行しておく（運営者の手順と同じ）
    command: `rm -rf .data/e2e && npm run db:seed && npm run -s mfa:ticket -- owner@e2e.test > .data/e2e/owner-ticket.txt && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...blanked,
      // 念のため、本番につながる値は .env ファイルの有無にかかわらず空にする
      DATABASE_URL: "",
      DATABASE_URL_UNPOOLED: "",
      BLOB_READ_WRITE_TOKEN: "",
      RESEND_API_KEY: "",
      VERCEL: "",
      EMAIL_VERIFICATION: "",
      PGLITE_DIR: ".data/e2e/pglite",
      UPLOAD_DIR: ".data/e2e/uploads",
      APP_URL: `http://localhost:${PORT}`,
      ENABLE_DEV_MAILBOX: "1",
      OWNER_EMAIL: "owner@e2e.test",
      OWNER_PASSWORD: "owner-password-123",
      OWNER_NAME: "オーナー",
      NEXT_TELEMETRY_DISABLED: "1",
      // 本番と同じく、明示した鍵で 2 段階認証の秘密鍵を暗号化する（テスト専用の値）
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    },
  },
});

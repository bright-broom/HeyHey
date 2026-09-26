/**
 * デザイン確認用のスクリーンショット（デモデータ前提）。
 *   BASE=http://localhost:3100 OUT=./shots node scripts/screenshots.mjs
 */
import fs from "node:fs";
import { chromium } from "@playwright/test";

const base = process.env.BASE ?? "http://localhost:3000";
const out = process.env.OUT ?? "shots";
const PASSWORD = "demo-password-123";
fs.mkdirSync(out, { recursive: true });
const executablePath = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome"].find((p) => fs.existsSync(p));
const browser = await chromium.launch(executablePath ? { executablePath } : {});

async function shoot(page, name, full = true) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(700); // フェードインが終わってから撮る
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: full });
}

async function session(email, width, pages) {
  const ctx = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 }, locale: "ja-JP" });
  const page = await ctx.newPage();
  if (email) {
    await page.goto(`${base}/login`);
    await page.fill("#email", email);
    await page.fill("#password", PASSWORD);
    await page.click("button[type=submit]");
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  }
  for (const [path, name, full] of pages) {
    await page.goto(base + path);
    await shoot(page, name, full ?? true);
  }
  await ctx.close();
}

await session(null, 1280, [["/login", "login", false]]);
await session(null, 390, [["/login", "login-mobile", false]]);
await session("sato@example.com", 1280, [["/", "feed"], ["/members", "members"], ["/invites", "invites"]]);
await session("tanaka@example.com", 390, [["/", "feed-mobile", false]]);
await session("admin@example.com", 1280, [["/admin", "admin"], ["/admin/applications", "applications"], ["/admin/reports", "reports"]]);
await browser.close();
console.log(`saved to ${out}`);

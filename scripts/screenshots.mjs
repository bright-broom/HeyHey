/**
 * デザイン確認用のスクリーンショット（デモデータ前提）。
 *   BASE=http://localhost:3100 OUT=./shots node scripts/screenshots.mjs
 */
import fs from "node:fs";
import { createHmac } from "node:crypto";
import { chromium } from "@playwright/test";

const base = process.env.BASE ?? "http://localhost:3000";
const out = process.env.OUT ?? "shots";
const PASSWORD = "demo-password-123";
/** scripts/seed.ts の DEMO_TOTP_SECRET */
const DEMO_TOTP_SECRET = "KAKOMIDEMOKAKOMIDEMOKAKOMIDEMO23";

function totp(secret, step) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", key).update(counter).digest();
  const o = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}
let lastStep = 0;
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
    await page.waitForURL((u) => u.pathname !== "/login");
    if (new URL(page.url()).pathname === "/login/2fa") {
      // 同じコードは 2 度使えないので、前回より後のステップのコードを使う
      lastStep = Math.max(Math.floor(Date.now() / 30000), lastStep + 1);
      await page.fill("#code", totp(DEMO_TOTP_SECRET, lastStep));
      await page.click("button[type=submit]");
      await page.waitForURL((u) => !u.pathname.startsWith("/login"));
    }
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

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { sessions, users } from "@/server/db/schema";
import { DEMO_ACCOUNTS, demoLoginEnabled } from "@/server/lib/demo";
import { isAdmin } from "@/server/lib/policy";
import { toViewer } from "@/server/lib/viewer";
import { demoLogin, userFromSession } from "@/server/services/auth";
import { db, makeUser } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

// test:pg では DATABASE_URL が入っているので、「ローカル開発」の条件を作ってから確かめる（接続は開いたまま）
const ENV_KEYS = ["NODE_ENV", "VERCEL", "DATABASE_URL", "APP_URL", "ALLOW_REMOTE_IN_DEV"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.DATABASE_URL;
  delete process.env.VERCEL;
  delete process.env.APP_URL;
  (process.env as Record<string, string>).NODE_ENV = "development";
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = saved[k]!;
  }
});

/** 台帳のメールアドレスで会員を用意する（test:pg で繰り返し流しても重複しない） */
async function demoUser(email: string, o: Parameters<typeof makeUser>[1] = {}) {
  const [u] = await d.select().from(users).where(eq(users.email, email));
  if (u) return u;
  return (await makeUser(d, { ...o, email })).user;
}

describe("デモアカウントの台帳", () => {
  it("メールアドレスは重複せず、すべての区分に 1 人以上いる。権限と状態の組み合わせを網羅する", () => {
    expect(new Set(DEMO_ACCOUNTS.map((a) => a.email)).size).toBe(DEMO_ACCOUNTS.length);
    for (const g of ["admin", "member", "applicant", "blocked"]) expect(DEMO_ACCOUNTS.some((a) => a.group === g)).toBe(true);
    const combos = new Set(DEMO_ACCOUNTS.map((a) => `${a.role}:${a.status}:${!!a.mfa}:${!!a.termsPending}`));
    for (const c of ["admin:active:true:false", "admin:active:false:false", "member:active:false:false", "member:active:true:false", "member:active:false:true", "member:pending:false:false", "member:unverified:false:false", "member:suspended:false:false", "member:rejected:false:false"]) {
      expect(combos).toContain(c);
    }
  });
});

describe("デモログイン", () => {
  it("台帳のアカウントなら、パスワードなしでセッションになる", async () => {
    const sato = await demoUser("sato@example.com");
    const res = await demoLogin(d, "SATO@example.com");
    expect(res).toMatchObject({ ok: true, mfa: false });
    if (res.ok !== true) return;
    expect((await userFromSession(d, res.token))?.user.id).toBe(sato.id);
  });

  it("管理権限は、そのアカウントの 2 段階認証の設定どおり（デモでも特別扱いしない）", async () => {
    await demoUser("admin@example.com", { role: "admin", mfa: true });
    await demoUser("admin-new@example.com", { role: "admin", mfa: false });
    const withMfa = await demoLogin(d, "admin@example.com");
    const without = await demoLogin(d, "admin-new@example.com");
    if (withMfa.ok !== true || without.ok !== true) throw new Error("expected sessions");
    expect(isAdmin(toViewer(withMfa.user, { mfa: withMfa.mfa }))).toBe(true);
    expect(isAdmin(toViewer(without.user, { mfa: without.mfa }))).toBe(false);
  });

  it("停止中・却下のアカウントは、通常のログインと同じく入れない", async () => {
    const nakamura = await demoUser("nakamura@example.com", { status: "suspended" });
    const watanabe = await demoUser("watanabe@example.com", { status: "rejected" });
    expect(await demoLogin(d, "nakamura@example.com")).toMatchObject({ ok: false, reason: "suspended" });
    expect(await demoLogin(d, "watanabe@example.com")).toMatchObject({ ok: false, reason: "rejected" });
    for (const u of [nakamura, watanabe]) expect(await d.select().from(sessions).where(eq(sessions.userId, u.id))).toHaveLength(0);
  });

  it("台帳にないアカウントには使えない（実在する会員でも）", async () => {
    const real = await makeUser(d, { role: "admin" });
    await expect(demoLogin(d, real.user.email)).rejects.toMatchObject({ code: "not_found" });
    await expect(demoLogin(d, "nobody@example.org")).rejects.toMatchObject({ code: "not_found" });
  });

  it.each([
    ["production ビルド", () => ((process.env as Record<string, string>).NODE_ENV = "production")],
    ["Vercel", () => (process.env.VERCEL = "1")],
    // 開発サーバーは .env.local のリモート DB を無視して PGlite を使う。実際にリモートへつなぐ設定のときは無効
    ["実際の PostgreSQL", () => Object.assign(process.env, { DATABASE_URL: "postgres://db.example.com/kakomi", ALLOW_REMOTE_IN_DEV: "1" })],
    ["手元の PostgreSQL", () => (process.env.DATABASE_URL = "postgres://postgres@localhost:5432/kakomi")],
    ["https の公開 URL", () => (process.env.APP_URL = "https://kakomi.example")],
  ])("%s では無効（画面にも出さず、呼ばれても not_found）", async (_, arrange) => {
    await demoUser("sato@example.com");
    expect(demoLoginEnabled()).toBe(true);
    arrange();
    expect(demoLoginEnabled()).toBe(false);
    await expect(demoLogin(d, "sato@example.com")).rejects.toMatchObject({ code: "not_found" });
  });
});

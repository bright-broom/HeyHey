import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditLogs, loginChallenges, mfaRecoveryCodes, sessions, userMfa } from "@/server/db/schema";
import { assertAdmin, assertOwner, hasAdminRole, isAdmin, monthlyInviteQuota } from "@/server/lib/policy";
import { open, seal } from "@/server/lib/secretbox";
import { base32Decode, base32Encode, totpCode, totpStep, verifyTotp } from "@/server/lib/totp";
import { listApplications, suspendUser } from "@/server/services/admin";
import { completeLogin, createSession, login, userFromSession } from "@/server/services/auth";
import { beginEnrollment, confirmEnrollment, disableMfa, getMfaState, regenerateRecoveryCodes, resetMfaByOperator } from "@/server/services/mfa";
import { db, makeUser, PASSWORD, refreshViewer } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const now = () => totpStep(Date.now());
const codeAt = (secret: string, step: number) => totpCode(secret, step);

describe("TOTP（RFC 6238）", () => {
  it("RFC 6238 付録 B のテストベクタ（SHA1・8 桁）と一致する", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    const cases: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, want] of cases) expect(totpCode(secret, Math.floor(t / 30), 8)).toBe(want);
  });

  it("Base32 は往復で元に戻る", () => {
    const buf = Buffer.from("kakomi-secret-\u0000ÿ");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("前後 1 ステップのずれは受け付け、2 ステップ以上や使用済みステップは拒否する", () => {
    const secret = base32Encode(Buffer.from("abcdefghijabcdefghij"));
    const t = 1_800_000_000_000;
    const s = totpStep(t);
    expect(verifyTotp(secret, totpCode(secret, s - 1), { now: t })).toBe(s - 1);
    expect(verifyTotp(secret, totpCode(secret, s + 1), { now: t })).toBe(s + 1);
    expect(verifyTotp(secret, totpCode(secret, s + 2), { now: t })).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, s), { now: t, afterStep: s })).toBeNull();
    expect(verifyTotp(secret, "12345", { now: t })).toBeNull();
    expect(verifyTotp(secret, "abcdef", { now: t })).toBeNull();
  });
});

describe("秘密鍵の暗号化", () => {
  it("復号できるのは同じ会員の行としてだけ。改ざんも検出する", () => {
    const sealed = seal("JBSWY3DPEHPK3PXP", "user_mfa:a");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(open(sealed, "user_mfa:a")).toBe("JBSWY3DPEHPK3PXP");
    expect(() => open(sealed, "user_mfa:b")).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => open(parts.join("."), "user_mfa:a")).toThrow();
  });

  it("本番で鍵が未設定なら、開発用の鍵にフォールバックせず止まる", () => {
    const prev = { v: process.env.VERCEL, k: process.env.MFA_ENCRYPTION_KEY };
    // test:pg では鍵を明示しているので、一時的に外して確かめる
    process.env.VERCEL = "1";
    delete process.env.MFA_ENCRYPTION_KEY;
    try {
      expect(() => seal("x", "a")).toThrow(/MFA_ENCRYPTION_KEY/);
    } finally {
      if (prev.v === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prev.v;
      if (prev.k !== undefined) process.env.MFA_ENCRYPTION_KEY = prev.k;
    }
  });
});

describe("管理権限は 2 段階認証が前提", () => {
  it("未設定の管理者は管理機能を使えず、招待枠も一般会員と同じ", async () => {
    const admin = await makeUser(d, { role: "admin", mfa: false });
    expect(hasAdminRole(admin.viewer)).toBe(true);
    expect(isAdmin(admin.viewer)).toBe(false);
    expect(() => assertAdmin(admin.viewer)).toThrow(/2 段階認証/);
    await expect(listApplications(d, admin.viewer)).rejects.toMatchObject({ code: "forbidden" });
    expect(monthlyInviteQuota(admin.viewer, null)).toBe(3);

    const owner = await makeUser(d, { role: "owner", mfa: false });
    expect(() => assertOwner(owner.viewer)).toThrow(/2 段階認証/);
  });

  it("設定済みなら従来どおり管理機能を使える。セッションからも mfa の状態を毎回読み直す", async () => {
    const admin = await makeUser(d, { role: "admin" });
    expect(isAdmin(admin.viewer)).toBe(true);
    await expect(listApplications(d, admin.viewer)).resolves.toBeDefined();
    const { token } = await createSession(d, admin.user.id);
    expect((await userFromSession(d, token))?.mfa).toBe(true);
    await resetMfaByOperator(d, admin.user.id, "テスト");
    expect(await userFromSession(d, token)).toBeNull(); // 運営者による解除でセッションも消える
    expect(isAdmin(await refreshViewer(d, admin.user.id))).toBe(false);
  });
});

describe("設定（有効化）", () => {
  it("パスワードと正しいコードの両方が必要。有効化するとリカバリーコード 10 個が出て、他の端末はログアウトされる", async () => {
    const m = await makeUser(d);
    const here = await createSession(d, m.user.id);
    const elsewhere = await createSession(d, m.user.id);
    const { secret, uri } = await beginEnrollment(d, m.viewer);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kakomi%3A/);
    expect((await getMfaState(d, m.viewer)).pending?.secret).toBe(secret);

    const [stored] = await d.select().from(userMfa).where(eq(userMfa.userId, m.user.id));
    expect(stored!.secretEnc).not.toContain(secret);

    await expect(confirmEnrollment(d, m.viewer, { password: "wrong-password", code: codeAt(secret, now()) })).rejects.toMatchObject({ code: "invalid" });
    await expect(confirmEnrollment(d, m.viewer, { password: PASSWORD, code: "000000" === codeAt(secret, now()) ? "111111" : "000000" })).rejects.toMatchObject({ code: "invalid" });

    const { recoveryCodes } = await confirmEnrollment(d, m.viewer, { password: PASSWORD, code: codeAt(secret, now()), keepSessionToken: here.token });
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(recoveryCodes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const hashes = await d.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, m.user.id));
    expect(hashes.map((h) => h.codeHash)).not.toContain(recoveryCodes[0]);

    expect(await userFromSession(d, here.token)).not.toBeNull();
    expect(await userFromSession(d, elsewhere.token)).toBeNull();
    const state = await getMfaState(d, await refreshViewer(d, m.user.id));
    expect(state).toMatchObject({ enabled: true, recoveryRemaining: 10, pending: null });

    // 有効化後に「設定を始める」を押しても、鍵は差し替わらない
    await expect(beginEnrollment(d, m.viewer)).rejects.toMatchObject({ code: "conflict" });
    const logs = await d.select().from(auditLogs).where(and(eq(auditLogs.targetId, m.user.id), eq(auditLogs.action, "mfa.enable")));
    expect(logs).toHaveLength(1);
  });
});

describe("ログインの 2 段階目", () => {
  async function enrolled() {
    const m = await makeUser(d, { mfa: true });
    return { ...m, secret: m.totpSecret! };
  }

  it("パスワードが正しくてもセッションは作らず、チャレンジだけを返す", async () => {
    const m = await enrolled();
    const res = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.1" });
    expect(res.ok).toBe("mfa");
    expect(await d.select().from(sessions).where(eq(sessions.userId, m.user.id))).toHaveLength(0);
    // チャレンジのトークンはセッションとしては通らない
    if (res.ok !== "mfa") return;
    expect(await userFromSession(d, res.challenge)).toBeNull();
  });

  it("正しいコードでセッションになる。同じチャレンジ・同じコードは 2 度使えない", async () => {
    const m = await enrolled();
    const res = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.2" });
    if (res.ok !== "mfa") throw new Error("expected mfa");
    const code = codeAt(m.secret, now());
    const done = await completeLogin(d, { challenge: res.challenge, code });
    expect(done).toMatchObject({ ok: true, mfa: true });
    expect(await completeLogin(d, { challenge: res.challenge, code })).toMatchObject({ ok: false, reason: "expired" });

    const again = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.2" });
    if (again.ok !== "mfa") throw new Error("expected mfa");
    expect(await completeLogin(d, { challenge: again.challenge, code })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("リカバリーコードは 1 回だけ使える", async () => {
    const m = await makeUser(d);
    const { secret } = await beginEnrollment(d, m.viewer);
    const { recoveryCodes } = await confirmEnrollment(d, m.viewer, { password: PASSWORD, code: codeAt(secret, now()) });
    const code = recoveryCodes[3]!.toUpperCase().replace("-", " ");

    const a = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.3" });
    if (a.ok !== "mfa") throw new Error("expected mfa");
    expect(await completeLogin(d, { challenge: a.challenge, code })).toMatchObject({ ok: true });
    const b = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.3" });
    if (b.ok !== "mfa") throw new Error("expected mfa");
    expect(await completeLogin(d, { challenge: b.challenge, code: recoveryCodes[3]! })).toMatchObject({ ok: false, reason: "invalid" });
    expect((await getMfaState(d, m.viewer)).recoveryRemaining).toBe(9);
  });

  it("総当たり：アカウントごとに 5 回で締め切り、その後は正しいコードでも通さない", async () => {
    const m = await enrolled();
    const wrong = codeAt(m.secret, now() + 5); // 許容範囲外のステップ＝必ず誤り
    for (let i = 0; i < 5; i++) {
      const c = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.4" });
      if (c.ok !== "mfa") throw new Error("expected mfa");
      expect((await completeLogin(d, { challenge: c.challenge, code: wrong })).ok).toBe(false);
    }
    const c = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.4" });
    if (c.ok !== "mfa") throw new Error("expected mfa");
    expect(await completeLogin(d, { challenge: c.challenge, code: codeAt(m.secret, now()) })).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("チャレンジごとの試行は 5 回まで。期限切れのチャレンジは使えない", async () => {
    const m = await enrolled();
    const c = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.5" });
    if (c.ok !== "mfa") throw new Error("expected mfa");
    await d.update(loginChallenges).set({ attempts: 5 }).where(eq(loginChallenges.userId, m.user.id));
    expect(await completeLogin(d, { challenge: c.challenge, code: codeAt(m.secret, now()) })).toMatchObject({ ok: false, reason: "expired" });

    const e = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.5" });
    if (e.ok !== "mfa") throw new Error("expected mfa");
    await d.update(loginChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(loginChallenges.userId, m.user.id));
    expect(await completeLogin(d, { challenge: e.challenge, code: codeAt(m.secret, now()) })).toMatchObject({ ok: false, reason: "expired" });
    expect(await completeLogin(d, { challenge: "x".repeat(300), code: "123456" })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("チャレンジの発行後に停止されたら、正しいコードでもログインできない", async () => {
    const owner = await makeUser(d, { role: "owner" });
    const m = await enrolled();
    const c = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.7.6" });
    if (c.ok !== "mfa") throw new Error("expected mfa");
    await suspendUser(d, owner.viewer, m.user.id, "テスト");
    expect(await completeLogin(d, { challenge: c.challenge, code: codeAt(m.secret, now()) })).toMatchObject({ ok: false, reason: "suspended" });
    expect(await d.select().from(sessions).where(eq(sessions.userId, m.user.id))).toHaveLength(0);
  });
});

describe("無効化・リカバリーコードの再発行", () => {
  it("一般会員はパスワード＋コードで無効化できる。管理者は無効化できない", async () => {
    const m = await makeUser(d, { mfa: true });
    await expect(disableMfa(d, m.viewer, { password: PASSWORD, code: "000000" })).rejects.toMatchObject({ code: "invalid" });
    await disableMfa(d, m.viewer, { password: PASSWORD, code: codeAt(m.totpSecret!, now()) });
    expect((await refreshViewer(d, m.user.id)).mfa).toBe(false);
    expect((await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.8.1" })).ok).toBe(true);

    const admin = await makeUser(d, { role: "admin" });
    await expect(disableMfa(d, admin.viewer, { password: PASSWORD, code: codeAt(admin.totpSecret!, now()) })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("再発行すると古いリカバリーコードは使えなくなる。再発行には認証アプリのコードが要る", async () => {
    const m = await makeUser(d);
    const { secret } = await beginEnrollment(d, m.viewer);
    const first = await confirmEnrollment(d, m.viewer, { password: PASSWORD, code: codeAt(secret, now()) });
    await expect(regenerateRecoveryCodes(d, m.viewer, { code: first.recoveryCodes[0]! })).rejects.toMatchObject({ code: "invalid" });
    const second = await regenerateRecoveryCodes(d, m.viewer, { code: codeAt(secret, now() + 1) });
    expect(second.recoveryCodes).toHaveLength(10);
    const c = await login(d, { email: m.user.email, password: PASSWORD, ip: "7.7.8.2" });
    if (c.ok !== "mfa") throw new Error("expected mfa");
    expect(await completeLogin(d, { challenge: c.challenge, code: first.recoveryCodes[1]! })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await completeLogin(d, { challenge: c.challenge, code: second.recoveryCodes[1]! })).toMatchObject({ ok: true });
  });
});

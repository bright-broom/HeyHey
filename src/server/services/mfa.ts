import { randomInt } from "node:crypto";
import { and, count, eq, gt, isNull, lt, ne, or } from "drizzle-orm";
import type { Db, DbOrTx } from "../db/client";
import { emailTokens, mfaRecoveryCodes, sessions, userMfa, users } from "../db/schema";
import { AppError, conflict, forbidden, invalid } from "../lib/errors";
import { verifyPassword } from "../lib/password";
import { assertMember, hasAdminRole } from "../lib/policy";
import { keyedHash, MissingKeyError, open, seal } from "../lib/secretbox";
import { hashToken, newToken } from "../lib/tokens";
import { newTotpSecret, otpauthUri, verifyTotp } from "../lib/totp";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { consume } from "./ratelimit";

/**
 * 2 段階認証（F-04）。認証アプリの TOTP を基本にし、端末をなくしたとき用にリカバリーコードを出す。
 * 管理者は必須（policy.isAdmin が mfa を見る）、会員は任意。
 *
 * 管理者の設定には、運営者が発行する 1 回限りの「設定チケット」も要る。
 * パスワードだけが漏れた未設定の管理者アカウントで、攻撃者が先に 2 段階認証を設定して
 * 管理権限を得る（しかも本人を締め出す）ことを防ぐため。
 */

export const RECOVERY_CODE_COUNT = 10;
/** 紛らわしい文字（0/o、1/l/i）を除いた 31 文字。10 文字で約 49 bit */
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SETUP_LIMIT = 10;
const SETUP_WINDOW_SEC = 15 * 60;
/** 「設定を始める」から確認までの猶予 */
const SETUP_TTL_MS = 15 * 60 * 1000;
export const ENROLL_TICKET_TTL_MIN = 30;
const TICKET_PURPOSE = "mfa_enroll";

export const sealAad = (userId: string) => `user_mfa:${userId}`;
const setupAad = (userId: string) => `mfa_setup:${userId}`;
const normalizeRecovery = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const hashRecovery = (userId: string, code: string) => keyedHash("recovery-code", `${userId}:${normalizeRecovery(code)}`);

function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const s = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** 鍵の設定漏れは、画面には運営者向けの一般的な文言で出す */
function withKey<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof MissingKeyError) throw new AppError("invalid", "サーバーの設定が不足しているため、2 段階認証を設定できません。運営者に連絡してください。");
    throw e;
  }
}

const tooMany = () => new AppError("rate_limited", "試行回数が上限に達しました。15 分ほど待ってから再度お試しください。");

export async function mfaEnabled(db: DbOrTx, userId: string): Promise<boolean> {
  const [row] = await db.select({ userId: userMfa.userId }).from(userMfa).where(eq(userMfa.userId, userId));
  return !!row;
}

export type MfaState = { enabled: boolean; enabledAt: Date | null; recoveryRemaining: number };

export async function getMfaState(db: Db, viewer: Viewer): Promise<MfaState> {
  assertMember(viewer);
  const [mfa] = await db.select({ enabledAt: userMfa.enabledAt }).from(userMfa).where(eq(userMfa.userId, viewer.id));
  if (!mfa) return { enabled: false, enabledAt: null, recoveryRemaining: 0 };
  const [{ n } = { n: 0 }] = await db
    .select({ n: count() })
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.userId, viewer.id), isNull(mfaRecoveryCodes.usedAt)));
  return { enabled: true, enabledAt: mfa.enabledAt, recoveryRemaining: n };
}

/**
 * 設定を始める：新しい鍵を作り、QR 用の URI と「封をした設定トークン」を返す。
 * 設定途中の鍵は DB に置かず、始めた人の画面にだけ渡す。乗っ取ったセッションで鍵を仕込んでおき、
 * 本人にそれを読み取らせる、という手口を防ぐため（毎回新しい鍵になり、15 分で失効する）。
 */
export async function beginEnrollment(db: Db, viewer: Viewer): Promise<{ secret: string; uri: string; setupToken: string }> {
  assertMember(viewer);
  if (await mfaEnabled(db, viewer.id)) throw conflict("2 段階認証はすでに有効です。");
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, viewer.id));
  const secret = newTotpSecret();
  const setupToken = withKey(() => seal(JSON.stringify({ s: secret, iat: Date.now() }), setupAad(viewer.id)));
  return { secret, uri: otpauthUri(secret, u!.email), setupToken };
}

function openSetupToken(userId: string, token: string): string | null {
  try {
    const { s, iat } = JSON.parse(open(token, setupAad(userId))) as { s: string; iat: number };
    return Date.now() - iat <= SETUP_TTL_MS ? s : null;
  } catch {
    return null;
  }
}

/** 管理者が設定するときに要る、1 回限りのチケット（運営者が scripts/mfa-ticket.ts で発行） */
export async function issueEnrollmentTicket(db: Db, userId: string): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = newToken();
  const expiresAt = new Date(Date.now() + ENROLL_TICKET_TTL_MIN * 60 * 1000);
  await db.insert(emailTokens).values({ tokenHash: hashToken(ticket), userId, purpose: TICKET_PURPOSE, expiresAt });
  await audit(db, { actorId: null, action: "mfa.ticket_issue", targetType: "user", targetId: userId });
  return { ticket, expiresAt };
}

/**
 * 設定を完了する。パスワードと認証アプリのコードの両方を確かめ、管理者はチケットも消費する。
 * 有効化したら、この端末以外のセッションはすべて破棄する。
 */
export async function confirmEnrollment(
  db: Db,
  viewer: Viewer,
  input: { password: string; code: string; setupToken: string; ticket?: string; keepSessionToken?: string },
): Promise<{ recoveryCodes: string[] }> {
  assertMember(viewer);
  if (!(await consume(db, `mfa:setup:${viewer.id}`, SETUP_LIMIT, SETUP_WINDOW_SEC))) throw tooMany();
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, viewer.id));
  if (!u || !(await verifyPassword(input.password, u.passwordHash))) throw invalid("パスワードが正しくありません。");
  const secret = withKey(() => openSetupToken(viewer.id, input.setupToken));
  if (!secret) throw invalid("設定の有効期限が切れました。「設定を始める」からやり直してください。");
  const step = verifyTotp(secret, input.code);
  if (step === null) throw invalid("確認コードが正しくありません。認証アプリに表示されている 6 桁の数字を入力してください。");
  const needsTicket = hasAdminRole(viewer);
  if (needsTicket && !input.ticket?.trim()) throw invalid("管理者の設定には、運営者が発行する設定チケットが必要です。");

  const codes = newRecoveryCodes();
  await db.transaction(async (tx) => {
    if (needsTicket) {
      const [used] = await tx
        .update(emailTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(emailTokens.tokenHash, hashToken(input.ticket!.trim())),
            eq(emailTokens.userId, viewer.id),
            eq(emailTokens.purpose, TICKET_PURPOSE),
            isNull(emailTokens.usedAt),
            gt(emailTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: emailTokens.userId });
      if (!used) throw invalid("設定チケットが正しくないか、有効期限が切れています。");
    }
    const [ok] = await tx
      .insert(userMfa)
      .values({ userId: viewer.id, secretEnc: seal(secret, sealAad(viewer.id)), lastUsedStep: step })
      .onConflictDoNothing()
      .returning({ userId: userMfa.userId });
    if (!ok) throw conflict("2 段階認証はすでに有効です。");
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, viewer.id));
    await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: viewer.id, codeHash: hashRecovery(viewer.id, c) })));
    await tx
      .delete(sessions)
      .where(and(eq(sessions.userId, viewer.id), input.keepSessionToken ? ne(sessions.tokenHash, hashToken(input.keepSessionToken)) : undefined));
    await audit(tx, { actorId: viewer.id, action: "mfa.enable", targetType: "user", targetId: viewer.id });
  });
  return { recoveryCodes: codes };
}

/**
 * 2 段階目の検証。6 桁なら TOTP、それ以外はリカバリーコードとして照合する。
 * どちらも条件付き UPDATE で 1 回きりの消費を保証する（同時に 2 回送っても片方しか通らない）。
 */
export async function checkSecondFactor(db: DbOrTx, userId: string, input: string): Promise<"totp" | "recovery" | null> {
  const [mfa] = await db.select().from(userMfa).where(eq(userMfa.userId, userId));
  if (!mfa) return null;
  const trimmed = input.trim();
  if (/^\d[\d\s]*$/.test(trimmed)) {
    const step = verifyTotp(open(mfa.secretEnc, sealAad(userId)), trimmed, { afterStep: mfa.lastUsedStep });
    if (step === null) return null;
    const [ok] = await db
      .update(userMfa)
      .set({ lastUsedStep: step })
      .where(and(eq(userMfa.userId, userId), or(isNull(userMfa.lastUsedStep), lt(userMfa.lastUsedStep, step))))
      .returning({ userId: userMfa.userId });
    return ok ? "totp" : null;
  }
  if (normalizeRecovery(trimmed).length !== 10) return null;
  const [used] = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(mfaRecoveryCodes.codeHash, hashRecovery(userId, trimmed)), eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)))
    .returning({ codeHash: mfaRecoveryCodes.codeHash });
  if (!used) return null;
  await audit(db, { actorId: userId, action: "mfa.recovery_code_used", targetType: "user", targetId: userId });
  return "recovery";
}

/** リカバリーコードを作り直す（古いものはすべて無効）。認証アプリのコードが必要 */
export async function regenerateRecoveryCodes(db: Db, viewer: Viewer, input: { code: string }): Promise<{ recoveryCodes: string[] }> {
  assertMember(viewer);
  if (!(await consume(db, `mfa:setup:${viewer.id}`, SETUP_LIMIT, SETUP_WINDOW_SEC))) throw tooMany();
  if (!/^\d[\d\s]*$/.test(input.code.trim())) throw invalid("認証アプリに表示されている 6 桁の数字を入力してください。");
  const codes = newRecoveryCodes();
  await db.transaction(async (tx) => {
    if ((await checkSecondFactor(tx, viewer.id, input.code)) !== "totp") throw invalid("確認コードが正しくありません。");
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, viewer.id));
    await tx.insert(mfaRecoveryCodes).values(codes.map((c) => ({ userId: viewer.id, codeHash: hashRecovery(viewer.id, c) })));
    await audit(tx, { actorId: viewer.id, action: "mfa.recovery_codes_regenerate", targetType: "user", targetId: viewer.id });
  });
  return { recoveryCodes: codes };
}

/** 無効化。会員だけが行える（管理者は必須のため外せない） */
export async function disableMfa(db: Db, viewer: Viewer, input: { password: string; code: string }): Promise<void> {
  assertMember(viewer);
  if (hasAdminRole(viewer)) throw forbidden("管理者は 2 段階認証を無効にできません。");
  if (!(await consume(db, `mfa:setup:${viewer.id}`, SETUP_LIMIT, SETUP_WINDOW_SEC))) throw tooMany();
  const [u] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, viewer.id));
  if (!u || !(await verifyPassword(input.password, u.passwordHash))) throw invalid("パスワードが正しくありません。");
  await db.transaction(async (tx) => {
    if (!(await checkSecondFactor(tx, viewer.id, input.code))) throw invalid("確認コードが正しくありません。");
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, viewer.id));
    await tx.delete(userMfa).where(eq(userMfa.userId, viewer.id));
    await audit(tx, { actorId: viewer.id, action: "mfa.disable", targetType: "user", targetId: viewer.id });
  });
}

/**
 * 運営者による解除（端末もリカバリーコードも失った場合）。DB に直接つなげる人だけが
 * scripts/reset-mfa.ts から呼ぶ。本人確認は運営者が別の手段で行う前提。
 */
export async function resetMfaByOperator(db: Db, userId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    await tx.delete(userMfa).where(eq(userMfa.userId, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await audit(tx, { actorId: null, action: "mfa.reset_by_operator", targetType: "user", targetId: userId, reason });
  });
}

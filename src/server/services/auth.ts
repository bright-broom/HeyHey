import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../db/client";
import { applications, emailTokens, invitations, loginChallenges, profiles, sessions, userMfa, users, type User } from "../db/schema";
import { demoLoginEnabled, isDemoEmail } from "../lib/demo";
import { AppError, invalid, notFound } from "../lib/errors";
import { burnPasswordCheck, hashPassword, PASSWORD_MIN, verifyPassword } from "../lib/password";
import { REAPPLY_COOLDOWN_DAYS } from "../lib/policy";
import { hashToken, newToken } from "../lib/tokens";
import { audit } from "./audit";
import { appUrl, sendMail } from "./mailer";
import { notifyAdmins } from "./notifications";
import { checkSecondFactor, mfaEnabled } from "./mfa";
import { consume, isLocked, reset } from "./ratelimit";
import { checkInvitation } from "./invites";

export const SESSION_TTL_DAYS = 30;
const VERIFY_TTL_HOURS = 24;
const DAY = 24 * 60 * 60 * 1000;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** メール送信サービスがまだない運用向けに、EMAIL_VERIFICATION=off で確認ステップを省ける */
export const emailVerificationEnabled = () => process.env.EMAIL_VERIFICATION !== "off";

// ───────── セッション ─────────

export async function createSession(db: DbOrTx, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * DAY);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/**
 * Cookie のトークンから会員を引く。期限切れは null。状態（停止など）と 2 段階認証の有無は毎回 DB の最新値
 */
export async function userFromSession(db: Db, token: string | undefined): Promise<{ user: User; mfa: boolean } | null> {
  if (!token || token.length > 200) return null;
  const rows = await db
    .select({ user: users, mfaEnabledAt: userMfa.enabledAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(userMfa, eq(userMfa.userId, users.id))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { user } = row;
  // 最終アクセス日時は 1 時間に 1 回だけ更新（週次アクティブ数の集計用）
  if (!user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > 60 * 60 * 1000) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  }
  return { user, mfa: row.mfaEnabledAt != null };
}

export async function deleteSession(db: DbOrTx, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function deleteUserSessions(db: DbOrTx, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// ───────── ログイン ─────────

const LOGIN_FAIL_LIMIT = 5;
const LOGIN_WINDOW_SEC = 15 * 60;
const CHALLENGE_TTL_MIN = 10;
const CHALLENGE_MAX_ATTEMPTS = 5;

type LoginFailure = { ok: false; reason: "invalid" | "rate_limited" | "suspended" | "rejected" | "withdrawn" | "expired" };

/**
 * ログイン可否の理由。画面ではメッセージを出し分けるが、パスワード誤りとアカウント不在は区別しない。
 * ok: "mfa" は「パスワードは正しいが 2 段階目が必要」。この時点ではセッションを作らない。
 */
export type LoginResult =
  | { ok: true; user: User; mfa: boolean; token: string; expiresAt: Date }
  | { ok: "mfa"; challenge: string; expiresAt: Date }
  | LoginFailure;

function statusFailure(user: User): LoginFailure | null {
  if (user.status === "suspended") return { ok: false, reason: "suspended" };
  if (user.status === "rejected") return { ok: false, reason: "rejected" };
  if (user.status === "withdrawn") return { ok: false, reason: "withdrawn" };
  return null;
}

export async function login(db: Db, input: { email: string; password: string; ip: string }): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const keyAccount = `login:acct:${email}`;
  const keyIp = `login:ip:${input.ip}`;

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const passwordOk = user ? await verifyPassword(input.password, user.passwordHash) : (await burnPasswordCheck(input.password), false);

  if (!passwordOk) {
    const accountOk = await consume(db, keyAccount, LOGIN_FAIL_LIMIT, LOGIN_WINDOW_SEC);
    const ipOk = await consume(db, keyIp, LOGIN_FAIL_LIMIT * 4, LOGIN_WINDOW_SEC);
    return { ok: false, reason: accountOk && ipOk ? "invalid" : "rate_limited" };
  }
  // 正しいパスワードでも、ロック中なら通さない（総当たりの最後の 1 回を成功させない）
  if (await isLocked(db, keyAccount, LOGIN_FAIL_LIMIT, LOGIN_WINDOW_SEC)) return { ok: false, reason: "rate_limited" };

  const blocked = statusFailure(user!);
  if (blocked) return blocked;

  await reset(db, keyAccount);
  if (await mfaEnabled(db, user!.id)) {
    await db.delete(loginChallenges).where(and(eq(loginChallenges.userId, user!.id), lt(loginChallenges.expiresAt, new Date())));
    const challenge = newToken();
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MIN * 60 * 1000);
    await db.insert(loginChallenges).values({ tokenHash: hashToken(challenge), userId: user!.id, expiresAt });
    return { ok: "mfa", challenge, expiresAt };
  }
  const session = await createSession(db, user!.id);
  return { ok: true, user: user!, mfa: false, ...session };
}

/**
 * ログインの 2 段階目。認証アプリのコードかリカバリーコードで、チャレンジをセッションに換える。
 * 総当たり対策は 2 重：チャレンジごとに 5 回、アカウントごとに 15 分で 5 回。
 * どちらも「照合の前に」原子的に 1 回分を確保する。並列に大量に送っても、照合されるのは上限までになる。
 */
export async function completeLogin(db: Db, input: { challenge: string; code: string }): Promise<LoginResult> {
  if (!input.challenge || input.challenge.length > 200) return { ok: false, reason: "expired" };
  const hash = hashToken(input.challenge);
  const [ch] = await db
    .update(loginChallenges)
    .set({ attempts: sql`${loginChallenges.attempts} + 1` })
    .where(and(eq(loginChallenges.tokenHash, hash), gt(loginChallenges.expiresAt, new Date()), lt(loginChallenges.attempts, CHALLENGE_MAX_ATTEMPTS)))
    .returning({ userId: loginChallenges.userId });
  if (!ch) return { ok: false, reason: "expired" };

  const keyAccount = `login:mfa:${ch.userId}`;
  if (!(await consume(db, keyAccount, LOGIN_FAIL_LIMIT, LOGIN_WINDOW_SEC))) return { ok: false, reason: "rate_limited" };

  const factor = await checkSecondFactor(db, ch.userId, input.code);
  if (!factor) return { ok: false, reason: "invalid" };

  return db.transaction(async (tx) => {
    // チャレンジは 1 回きり。同時に 2 回通っても、消せた方だけがセッションを得る
    const [consumed] = await tx.delete(loginChallenges).where(eq(loginChallenges.tokenHash, hash)).returning({ userId: loginChallenges.userId });
    if (!consumed) return { ok: false, reason: "expired" } as const;
    // チャレンジ発行後に停止された場合も通さない
    const [user] = await tx.select().from(users).where(eq(users.id, consumed.userId));
    const blocked = statusFailure(user!);
    if (blocked) return blocked;
    await reset(tx, keyAccount);
    const session = await createSession(tx, user!.id);
    return { ok: true, user: user!, mfa: true, ...session } as const;
  });
}

/**
 * デモログイン（ローカル開発専用）。台帳（lib/demo）にあるアカウントだけ、パスワードと 2 段階認証を省いて入る。
 * 状態のルール（停止・却下は入れない）は通常のログインと同じ。管理権限は、そのアカウントが
 * 2 段階認証を設定済みかどうかで決まる（userFromSession が毎回読む）ので、ここで特別扱いはしない。
 */
export async function demoLogin(db: Db, emailRaw: string): Promise<LoginResult> {
  if (!demoLoginEnabled()) throw notFound();
  const email = normalizeEmail(emailRaw);
  if (!isDemoEmail(email)) throw notFound();
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw notFound("このデモアカウントはまだありません。npm run demo を実行してください。");
  const blocked = statusFailure(user);
  if (blocked) return blocked;
  const session = await createSession(db, user.id);
  return { ok: true, user, mfa: await mfaEnabled(db, user.id), ...session };
}

// ───────── 登録（招待リンク＋申請フォーム） ─────────

export const registerSchema = z.object({
  token: z.string().min(10).max(200),
  email: z.string().trim().toLowerCase().email("メールアドレスの形式が正しくありません。").max(254),
  password: z
    .string()
    .min(PASSWORD_MIN, `パスワードは ${PASSWORD_MIN} 文字以上にしてください。`)
    .max(200, "パスワードが長すぎます。"),
  displayName: z.string().trim().min(1, "表示名を入力してください。").max(40, "表示名は 40 文字以内です。"),
  fullName: z.string().trim().min(1, "氏名を入力してください。").max(80),
  affiliation: z.string().trim().max(120).default(""),
  relationship: z.string().trim().min(1, "招待者との関係を入力してください。").max(200),
  introduction: z.string().trim().min(1, "自己紹介を入力してください。").max(1000, "自己紹介は 1000 文字以内です。"),
});
export type RegisterInput = z.input<typeof registerSchema>;

/**
 * 招待リンクから登録し、同時に入会申請を作る。
 * 招待の消費・会員作成・申請作成を 1 トランザクションで行い、
 * 使用回数の上限は UPDATE ... WHERE use_count < max_uses で原子的に守る。
 */
export async function register(db: Db, raw: RegisterInput, ctx: { ip: string }): Promise<{ userId: string | null }> {
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const input = parsed.data;

  if (!(await consume(db, `register:ip:${ctx.ip}`, 30, 60 * 60))) {
    throw new AppError("rate_limited", "短時間に登録が集中しています。時間をおいて再度お試しください。");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await db.transaction(async (tx) => {
    const inv = await checkInvitation(tx, input.token);
    if (!inv.ok) throw invalid(inv.message);

    // 招待は先に消費する。既存アドレスでの登録でも 1 回分を使うので、
    // 招待リンク 1 本で「このメールは登録済みか」を何度も試すことはできない
    const [claimed] = await tx
      .update(invitations)
      .set({ useCount: sql`${invitations.useCount} + 1` })
      .where(
        and(
          eq(invitations.id, inv.invitation.id),
          isNull(invitations.revokedAt),
          gt(invitations.expiresAt, new Date()),
          lt(invitations.useCount, invitations.maxUses),
        ),
      )
      .returning({ id: invitations.id, createdById: invitations.createdById });
    if (!claimed) throw invalid("この招待リンクは使用済みか、有効期限が切れています。");

    const [existing] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
    const reusable =
      existing &&
      // 却下から 30 日経過後の再申請
      ((existing.status === "rejected" && existing.rejectedAt && Date.now() - existing.rejectedAt.getTime() >= REAPPLY_COOLDOWN_DAYS * DAY) ||
        // 確認されないまま期限切れになった登録（他人のアドレスの「押さえ」を防ぐ）
        (existing.status === "unverified" && Date.now() - existing.updatedAt.getTime() >= VERIFY_TTL_HOURS * 60 * 60 * 1000));

    if (existing && !reusable) {
      // 登録済みのアドレス：画面上は通常の登録と同じ応答にし（存在を明かさない）、本人にだけ知らせる
      await audit(tx, { actorId: null, action: "user.register_existing_email", targetType: "user", targetId: existing.id, meta: { invitationId: claimed.id } });
      await sendMail(tx, {
        to: existing.email,
        subject: "【Kakomi】このメールアドレスで登録の申し込みがありました",
        body: [
          "このメールアドレスで Kakomi への新規登録が試みられましたが、すでにアカウントがあるため登録は行っていません。",
          "ご自身の操作であれば、ログイン画面からログインしてください。心当たりがない場合は、このメールを破棄してください。",
          "",
          appUrl("/login"),
        ].join("\n"),
      });
      return { userId: null };
    }

    let userId: string;
    if (existing) {
      await tx
        .update(users)
        .set({
          passwordHash,
          displayName: input.displayName,
          status: "unverified",
          invitedById: claimed.createdById,
          invitationId: claimed.id,
          emailVerifiedAt: null,
          rejectedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
      await tx.update(emailTokens).set({ usedAt: new Date() }).where(and(eq(emailTokens.userId, existing.id), isNull(emailTokens.usedAt)));
      await tx.delete(applications).where(and(eq(applications.userId, existing.id), inArray(applications.status, ["pending", "on_hold"])));
      userId = existing.id;
    } else {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          displayName: input.displayName,
          invitedById: claimed.createdById,
          invitationId: claimed.id,
        })
        .returning({ id: users.id });
      userId = u!.id;
      await tx.insert(profiles).values({ userId, affiliation: input.affiliation });
    }

    await tx.insert(applications).values({
      userId,
      fullName: input.fullName,
      affiliation: input.affiliation,
      relationship: input.relationship,
      introduction: input.introduction,
    });
    await audit(tx, { actorId: userId, action: "user.register", targetType: "user", targetId: userId, meta: { invitationId: claimed.id } });
    if (emailVerificationEnabled()) {
      await issueVerification(tx, userId, input.email, { displayName: input.displayName, inviterName: inv.inviterName });
    } else {
      // メール確認を省く運用：招待リンク＋管理者の承認だけで入会を判断する
      await tx.update(users).set({ status: "pending", updatedAt: new Date() }).where(eq(users.id, userId));
      await notifyAdmins(tx, { type: "application_submitted", actorId: userId, data: { name: input.displayName } });
    }
    return { userId };
  });
  return result;
}

async function issueVerification(db: DbOrTx, userId: string, email: string, who: { displayName: string; inviterName?: string }) {
  const token = newToken();
  await db.insert(emailTokens).values({
    tokenHash: hashToken(token),
    userId,
    purpose: "verify_email",
    expiresAt: new Date(Date.now() + VERIFY_TTL_HOURS * 60 * 60 * 1000),
  });
  await sendMail(db, {
    to: email,
    subject: "【Kakomi】メールアドレスの確認",
    body: [
      "Kakomi への入会申請ありがとうございます。",
      `申請内容：表示名「${who.displayName}」${who.inviterName ? `／招待者「${who.inviterName}」` : ""}`,
      "",
      "ご自身の申請であれば、下のリンクを開いて確認を完了してください。申請が管理者に届きます。",
      "ご自身の申請でない場合はリンクを開かず、このメールを破棄してください。",
      "",
      appUrl(`/verify/${token}`),
      "",
      `このリンクの有効期限は ${VERIFY_TTL_HOURS} 時間です。`,
      "心当たりがない場合は、このメールを破棄してください。",
    ].join("\n"),
  });
}

/** メール確認。成功すると申請中（pending）になり、管理者に通知が届く */
export async function verifyEmail(db: Db, token: string): Promise<{ ok: boolean }> {
  if (!token || token.length > 200) return { ok: false };
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(emailTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(emailTokens.tokenHash, hashToken(token)),
          eq(emailTokens.purpose, "verify_email"),
          isNull(emailTokens.usedAt),
          gt(emailTokens.expiresAt, new Date()),
        ),
      )
      .returning({ userId: emailTokens.userId });
    if (!row) return { ok: false };
    const [u] = await tx
      .update(users)
      .set({ status: "pending", emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, row.userId), eq(users.status, "unverified")))
      .returning({ id: users.id, displayName: users.displayName });
    if (!u) return { ok: false };
    await notifyAdmins(tx, { type: "application_submitted", actorId: u.id, data: { name: u.displayName } });
    return { ok: true };
  });
}

/** 確認メールの再送。存在しないアドレスでも同じ応答にする */
export async function resendVerification(db: Db, emailRaw: string, ctx: { ip: string }): Promise<void> {
  const email = normalizeEmail(emailRaw);
  if (!(await consume(db, `resend:${email}`, 3, 60 * 60))) return;
  if (!(await consume(db, `resend:ip:${ctx.ip}`, 10, 60 * 60))) return;
  const [u] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!u || u.status !== "unverified") return;
  await issueVerification(db, u.id, u.email, { displayName: u.displayName });
}

export async function acceptTerms(db: Db, userId: string): Promise<void> {
  await db
    .update(users)
    .set({ termsAcceptedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.status, "active"), isNull(users.termsAcceptedAt)));
  await audit(db, { actorId: userId, action: "user.accept_terms", targetType: "user", targetId: userId });
}

export async function changePassword(db: Db, userId: string, current: string, next: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !(await verifyPassword(current, u.passwordHash))) throw invalid("現在のパスワードが正しくありません。");
  if (next.length < PASSWORD_MIN) throw invalid(`パスワードは ${PASSWORD_MIN} 文字以上にしてください。`);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash: await hashPassword(next), updatedAt: new Date() }).where(eq(users.id, userId));
    await deleteUserSessions(tx, userId);
  });
}

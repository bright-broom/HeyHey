import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../db/client";
import { applications, emailTokens, invitations, profiles, rateLimits, sessions, users, type User } from "../db/schema";
import { AppError, conflict, invalid } from "../lib/errors";
import { burnPasswordCheck, hashPassword, PASSWORD_MIN, verifyPassword } from "../lib/password";
import { REAPPLY_COOLDOWN_DAYS } from "../lib/policy";
import { hashToken, newToken } from "../lib/tokens";
import { audit } from "./audit";
import { appUrl, sendMail } from "./mailer";
import { notifyAdmins } from "./notifications";
import { consume, reset } from "./ratelimit";
import { checkInvitation } from "./invites";

export const SESSION_TTL_DAYS = 30;
const VERIFY_TTL_HOURS = 24;
const DAY = 24 * 60 * 60 * 1000;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

// ───────── セッション ─────────

export async function createSession(db: DbOrTx, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * DAY);
  await db.insert(sessions).values({ tokenHash: hashToken(token), userId, expiresAt });
  return { token, expiresAt };
}

/** Cookie のトークンから会員を引く。期限切れは null。状態（停止など）は毎回 DB の最新値 */
export async function userFromSession(db: Db, token: string | undefined): Promise<User | null> {
  if (!token || token.length > 200) return null;
  const rows = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const user = rows[0]?.user ?? null;
  // 最終アクセス日時は 1 時間に 1 回だけ更新（週次アクティブ数の集計用）
  if (user && (!user.lastSeenAt || Date.now() - user.lastSeenAt.getTime() > 60 * 60 * 1000)) {
    await db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, user.id));
  }
  return user;
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

/** ログイン可否の理由。画面ではメッセージを出し分けるが、パスワード誤りとアカウント不在は区別しない */
export type LoginResult =
  | { ok: true; user: User; token: string; expiresAt: Date }
  | { ok: false; reason: "invalid" | "rate_limited" | "suspended" | "rejected" | "withdrawn" };

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
  const [lock] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.key, keyAccount),
        gt(rateLimits.windowStartedAt, sql`now() - make_interval(secs => ${LOGIN_WINDOW_SEC})`),
      ),
    );
  if (lock && lock.count >= LOGIN_FAIL_LIMIT) return { ok: false, reason: "rate_limited" };

  if (user!.status === "suspended") return { ok: false, reason: "suspended" };
  if (user!.status === "rejected") return { ok: false, reason: "rejected" };
  if (user!.status === "withdrawn") return { ok: false, reason: "withdrawn" };

  await reset(db, keyAccount);
  const session = await createSession(db, user!.id);
  return { ok: true, user: user!, ...session };
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
export async function register(db: Db, raw: RegisterInput, ctx: { ip: string }): Promise<{ userId: string }> {
  const parsed = registerSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const input = parsed.data;

  if (!(await consume(db, `register:ip:${ctx.ip}`, 10, 60 * 60))) {
    throw new AppError("rate_limited", "短時間に登録が集中しています。時間をおいて再度お試しください。");
  }

  const passwordHash = await hashPassword(input.password);

  const result = await db.transaction(async (tx) => {
    const inv = await checkInvitation(tx, input.token);
    if (!inv.ok) throw invalid(inv.message);

    const [existing] = await tx.select().from(users).where(eq(users.email, input.email)).limit(1);
    if (existing) {
      const cooledDown =
        existing.status === "rejected" &&
        existing.rejectedAt &&
        Date.now() - existing.rejectedAt.getTime() >= REAPPLY_COOLDOWN_DAYS * DAY;
      if (!cooledDown) {
        // どの状態で存在するかは教えない（メールアドレスの存在確認に使われないように）
        throw conflict("このメールアドレスでは登録できません。すでに登録済みの場合はログインしてください。");
      }
    }

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

    let userId: string;
    if (existing) {
      // 却下から 30 日経過後の再申請：同じ行を申請中に戻す
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
    await issueVerification(tx, userId, input.email);
    return { userId };
  });
  return result;
}

async function issueVerification(db: DbOrTx, userId: string, email: string) {
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
      "下のリンクを開くとメールアドレスの確認が完了し、申請が管理者に届きます。",
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
  await issueVerification(db, u.id, u.email);
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

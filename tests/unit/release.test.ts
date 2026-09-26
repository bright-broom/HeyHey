import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { applications, auditLogs, comments, mailOutbox, notifications, posts, reports, sessions, users } from "@/server/db/schema";
import { totpCode, totpStep } from "@/server/lib/totp";
import { transferOwnership } from "@/server/services/admin";
import { createSession, login, requestPasswordReset, resetPassword, userFromSession } from "@/server/services/auth";
import { exportMyData } from "@/server/services/export";
import { runDailyMaintenance } from "@/server/services/maintenance";
import { releaseChecks } from "@/server/services/readiness";
import { GET as cronGET } from "@/app/api/cron/daily/route";
import { db, makeUser, PASSWORD, rawPost, refreshViewer } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

const DAY = 86400_000;
const lastMailTo = async (to: string) => (await d.select().from(mailOutbox).where(eq(mailOutbox.to, to)).orderBy(desc(mailOutbox.createdAt)).limit(1))[0];
const tokenIn = (body: string) => body.match(/\/reset\/([A-Za-z0-9_-]+)/)?.[1];

describe("パスワードの再設定", () => {
  it("リンクは 1 回きり。設定すると全端末からログアウトし、新しいパスワードで入れる", async () => {
    const m = await makeUser(d);
    const s1 = await createSession(d, m.user.id);
    await requestPasswordReset(d, m.user.email.toUpperCase(), { ip: "8.8.8.1" });
    const token = tokenIn((await lastMailTo(m.user.email))!.body)!;
    expect(token).toBeTruthy();

    await expect(resetPassword(d, token, "short")).rejects.toMatchObject({ code: "invalid" });
    await resetPassword(d, token, "brand-new-password-1");
    expect(await userFromSession(d, s1.token)).toBeNull();
    expect((await login(d, { email: m.user.email, password: PASSWORD, ip: "8.8.8.1" })).ok).toBe(false);
    expect((await login(d, { email: m.user.email, password: "brand-new-password-1", ip: "8.8.8.1" })).ok).toBe(true);
    await expect(resetPassword(d, token, "another-password-2")).rejects.toMatchObject({ code: "invalid" });
    expect((await lastMailTo(m.user.email))!.subject).toContain("パスワードが変更されました");
  });

  it("新しいリンクを出すと古いリンクは使えない。期限切れも使えない", async () => {
    const m = await makeUser(d);
    await requestPasswordReset(d, m.user.email, { ip: "8.8.8.2" });
    const first = tokenIn((await lastMailTo(m.user.email))!.body)!;
    await requestPasswordReset(d, m.user.email, { ip: "8.8.8.2" });
    const second = tokenIn((await lastMailTo(m.user.email))!.body)!;
    await expect(resetPassword(d, first, "brand-new-password-1")).rejects.toMatchObject({ code: "invalid" });

    await d.execute(sql`UPDATE email_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = ${m.user.id}`);
    await expect(resetPassword(d, second, "brand-new-password-1")).rejects.toMatchObject({ code: "invalid" });
  });

  it("未登録・停止中のアドレスには送らないが、応答は同じ（アドレスの存在を明かさない）", async () => {
    const suspended = await makeUser(d, { status: "suspended" });
    await expect(requestPasswordReset(d, "nobody-here@example.com", { ip: "8.8.8.3" })).resolves.toBeUndefined();
    await expect(requestPasswordReset(d, suspended.user.email, { ip: "8.8.8.3" })).resolves.toBeUndefined();
    expect(await lastMailTo("nobody-here@example.com")).toBeUndefined();
    expect(await lastMailTo(suspended.user.email)).toBeUndefined();
  });

  it("同じアドレスへの送信は 1 時間 3 回まで", async () => {
    const m = await makeUser(d);
    for (let i = 0; i < 5; i++) await requestPasswordReset(d, m.user.email, { ip: `8.8.9.${i}` });
    expect(await d.select().from(mailOutbox).where(eq(mailOutbox.to, m.user.email))).toHaveLength(3);
  });

  it("再設定しても 2 段階認証は外れない", async () => {
    const m = await makeUser(d, { mfa: true });
    await requestPasswordReset(d, m.user.email, { ip: "8.8.8.4" });
    await resetPassword(d, tokenIn((await lastMailTo(m.user.email))!.body)!, "brand-new-password-1");
    expect((await login(d, { email: m.user.email, password: "brand-new-password-1", ip: "8.8.8.4" })).ok).toBe("mfa");
  });
});

describe("オーナー権限の移譲", () => {
  const code = (secret: string, offset = 0) => totpCode(secret, totpStep(Date.now()) + offset);

  it("2 段階認証済みの管理者にだけ、パスワードとコードで移せる。移した後は元のオーナーが管理者になる", async () => {
    const owner = await makeUser(d, { role: "owner" });
    const admin = await makeUser(d, { role: "admin" });
    const noMfa = await makeUser(d, { role: "admin", mfa: false });
    const member = await makeUser(d, { mfa: true });

    await expect(transferOwnership(d, admin.viewer, owner.user.id, { password: PASSWORD, code: code(admin.totpSecret!) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(transferOwnership(d, owner.viewer, member.user.id, { password: PASSWORD, code: code(owner.totpSecret!) })).rejects.toMatchObject({ code: "conflict" });
    await expect(transferOwnership(d, owner.viewer, noMfa.user.id, { password: PASSWORD, code: code(owner.totpSecret!) })).rejects.toMatchObject({ code: "conflict" });
    await expect(transferOwnership(d, owner.viewer, admin.user.id, { password: "wrong-password", code: code(owner.totpSecret!) })).rejects.toMatchObject({ code: "invalid" });
    await expect(transferOwnership(d, owner.viewer, admin.user.id, { password: PASSWORD, code: code(owner.totpSecret!, 5) })).rejects.toMatchObject({ code: "invalid" });

    await transferOwnership(d, owner.viewer, admin.user.id, { password: PASSWORD, code: code(owner.totpSecret!) });
    expect((await refreshViewer(d, owner.user.id)).role).toBe("admin");
    expect((await refreshViewer(d, admin.user.id)).role).toBe("owner");
    const [log] = await d.select().from(auditLogs).where(and(eq(auditLogs.action, "user.transfer_ownership"), eq(auditLogs.targetId, admin.user.id)));
    expect(log).toBeDefined();
    const [n] = await d.select().from(notifications).where(and(eq(notifications.userId, admin.user.id), eq(notifications.type, "ownership_transferred")));
    expect(n).toBeDefined();

    // 古い Viewer（まだオーナーのつもり）で二重に移そうとしても、オーナーは増えない
    const another = await makeUser(d, { role: "admin" });
    await expect(transferOwnership(d, owner.viewer, another.user.id, { password: PASSWORD, code: code(owner.totpSecret!, 1) })).rejects.toMatchObject({ code: "conflict" });
    expect((await refreshViewer(d, another.user.id)).role).toBe("admin");
  });
});

describe("毎日の定期処理", () => {
  it("削除から 30 日たった投稿は消し、コメントは本文だけ消す。30 日未満は残す", async () => {
    const m = await makeUser(d);
    const old = await rawPost(d, m.user.id, { body: "old", deletedAt: new Date(Date.now() - 31 * DAY) });
    const recent = await rawPost(d, m.user.id, { body: "recent", deletedAt: new Date(Date.now() - 29 * DAY) });
    const live = await rawPost(d, m.user.id);
    const [c] = await d.insert(comments).values({ postId: live.id, authorId: m.user.id, body: "消したコメント", deletedAt: new Date(Date.now() - 31 * DAY) }).returning();
    await d.insert(comments).values({ postId: old.id, authorId: m.user.id, body: "消える投稿へのコメント" });

    const r = await runDailyMaintenance(d);
    expect(r.purgedPosts).toBeGreaterThanOrEqual(1);
    const left = (await d.select({ id: posts.id }).from(posts).where(eq(posts.authorId, m.user.id))).map((p) => p.id);
    expect(left).not.toContain(old.id);
    expect(left).toEqual(expect.arrayContaining([recent.id, live.id]));
    const [erased] = await d.select().from(comments).where(eq(comments.id, c!.id));
    expect(erased!.body).toBe("");
  });

  it("未処理の通報がかかった投稿・コメントは、本人が消しても 30 日で消さない（対応が終わってから消す）", async () => {
    const author = await makeUser(d);
    const reporter = await makeUser(d);
    const reported = await rawPost(d, author.user.id, { body: "通報された投稿", deletedAt: new Date(Date.now() - 31 * DAY) });
    const live = await rawPost(d, author.user.id);
    const [c] = await d.insert(comments).values({ postId: live.id, authorId: author.user.id, body: "通報されたコメント", deletedAt: new Date(Date.now() - 31 * DAY) }).returning();
    await d.insert(reports).values([
      { reporterId: reporter.user.id, targetType: "post", targetId: reported.id, targetUserId: author.user.id, reason: "harassment" },
      { reporterId: reporter.user.id, targetType: "comment", targetId: c!.id, targetUserId: author.user.id, reason: "harassment" },
    ]);
    await runDailyMaintenance(d);
    expect(await d.select().from(posts).where(eq(posts.id, reported.id))).toHaveLength(1);
    expect((await d.select().from(comments).where(eq(comments.id, c!.id)))[0]!.body).toBe("通報されたコメント");

    await d.update(reports).set({ status: "resolved", resolution: "dismissed", resolvedAt: new Date() }).where(eq(reports.reporterId, reporter.user.id));
    await runDailyMaintenance(d);
    expect(await d.select().from(posts).where(eq(posts.id, reported.id))).toHaveLength(0);
    expect((await d.select().from(comments).where(eq(comments.id, c!.id)))[0]!.body).toBe("");
  });

  it("退会から 30 日たった人の申請内容と通知を消す", async () => {
    const m = await makeUser(d);
    await d.insert(applications).values({ userId: m.user.id, fullName: "（退会）", affiliation: "", relationship: "", introduction: "" });
    await d.insert(notifications).values({ userId: m.user.id, type: "comment" });
    await d.update(users).set({ status: "withdrawn", withdrawnAt: new Date(Date.now() - 31 * DAY) }).where(eq(users.id, m.user.id));
    await runDailyMaintenance(d);
    expect(await d.select().from(applications).where(eq(applications.userId, m.user.id))).toHaveLength(0);
    expect(await d.select().from(notifications).where(eq(notifications.userId, m.user.id))).toHaveLength(0);
  });

  it("72 時間を超えた申請は、管理者に 1 回だけ再通知する", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const applicant = await makeUser(d, { status: "pending" });
    const [app] = await d.insert(applications).values({ userId: applicant.user.id, fullName: "遅延 太郎", affiliation: "", relationship: "友人", introduction: "よろしく", createdAt: new Date(Date.now() - 80 * 3600_000) }).returning();
    await runDailyMaintenance(d);
    await runDailyMaintenance(d);
    const mine = await d.select().from(notifications).where(and(eq(notifications.userId, admin.user.id), eq(notifications.type, "application_overdue")));
    expect(mine.filter((n) => (n.data as { applicationId?: string }).applicationId === app!.id)).toHaveLength(1);
  });

  it("期限切れのセッションを片付け、実行を監査ログに残す", async () => {
    const m = await makeUser(d);
    await d.insert(sessions).values({ tokenHash: `expired-${m.user.id}`, userId: m.user.id, expiresAt: new Date(Date.now() - 1000) });
    await runDailyMaintenance(d);
    expect(await d.select().from(sessions).where(eq(sessions.tokenHash, `expired-${m.user.id}`))).toHaveLength(0);
    const [log] = await d.select().from(auditLogs).where(eq(auditLogs.action, "system.maintenance")).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(log).toBeDefined();
  });

  describe("Cron のエンドポイント", () => {
    const prev = process.env.CRON_SECRET;
    afterEach(() => {
      if (prev === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = prev;
    });
    const call = (auth?: string) => cronGET(new Request("http://localhost/api/cron/daily", { headers: auth ? { authorization: auth } : {} }));

    it("CRON_SECRET が未設定なら誰も実行できない。鍵が違っても 404", async () => {
      delete process.env.CRON_SECRET;
      expect((await call("Bearer undefined")).status).toBe(404);
      process.env.CRON_SECRET = "s3cret-value-for-test";
      expect((await call()).status).toBe(404);
      expect((await call("Bearer wrong-value-for-test!")).status).toBe(404);
      // 文字数は同じでもバイト数が違う値で、例外（500）や長さの推測を起こさない
      expect((await call("Bearer " + "é".repeat("s3cret-value-for-test".length))).status).toBe(404);
      const ok = await call("Bearer s3cret-value-for-test");
      expect(ok.status).toBe(200);
      expect(await ok.json()).toHaveProperty("expired");
    });
  });
});

describe("データのダウンロード", () => {
  it("本人のデータだけを出し、パスワードや秘密は含めない。書き出しは監査ログに残る", async () => {
    const m = await makeUser(d, { mfa: true });
    const other = await makeUser(d);
    await rawPost(d, m.user.id, { body: "わたしの投稿" });
    await rawPost(d, other.user.id, { body: "ほかの人の投稿" });
    const data = await exportMyData(d, m.viewer);
    const json = JSON.stringify(data);
    expect(data.account.email).toBe(m.user.email);
    expect(data.posts.map((p) => p.body)).toEqual(["わたしの投稿"]);
    expect(json).not.toContain("ほかの人の投稿");
    for (const secret of ["passwordHash", "password_hash", "secretEnc", "tokenHash", m.totpSecret!, "scrypt$"]) expect(json).not.toContain(secret);
    const [log] = await d.select().from(auditLogs).where(and(eq(auditLogs.action, "user.export"), eq(auditLogs.targetId, m.user.id)));
    expect(log).toBeDefined();
  });

  it("1 日 5 回まで。未承認の人は使えない", async () => {
    const m = await makeUser(d);
    for (let i = 0; i < 5; i++) await exportMyData(d, m.viewer);
    await expect(exportMyData(d, m.viewer)).rejects.toMatchObject({ code: "rate_limited" });
    const pending = await makeUser(d, { status: "pending" });
    await expect(exportMyData(d, pending.viewer)).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("リリース前チェック", () => {
  it("オーナーだけが見られ、設定の有無を正しく判定する（値そのものは出さない）", async () => {
    const owner = await makeUser(d, { role: "owner" });
    const admin = await makeUser(d, { role: "admin" });
    await expect(releaseChecks(d, admin.viewer)).rejects.toMatchObject({ code: "forbidden" });

    const keys = ["RESEND_API_KEY", "MAIL_FROM", "OPERATOR_NAME", "CONTACT_EMAIL"] as const;
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      let checks = await releaseChecks(d, owner.viewer);
      expect(checks.find((c) => c.id === "mail")!.ok).toBe(false);
      expect(checks.find((c) => c.id === "operator")!.ok).toBe(false);
      expect(checks.find((c) => c.id === "admins")!.ok).toBe(true); // オーナーと管理者の 2 人

      Object.assign(process.env, { RESEND_API_KEY: "re_test_secret_value", MAIL_FROM: "Kakomi <no-reply@example.com>", OPERATOR_NAME: "BrightBroom", CONTACT_EMAIL: "hello@example.com" });
      checks = await releaseChecks(d, owner.viewer);
      expect(checks.find((c) => c.id === "mail")!.ok).toBe(true);
      expect(checks.find((c) => c.id === "operator")!.ok).toBe(true);
      expect(JSON.stringify(checks)).not.toContain("re_test_secret_value");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});

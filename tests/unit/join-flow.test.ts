import { beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { applications, invitations, mailOutbox, notifications, users } from "@/server/db/schema";
import { isMember } from "@/server/lib/policy";
import { decideApplication, listApplications } from "@/server/services/admin";
import { acceptTerms, login, register, verifyEmail } from "@/server/services/auth";
import { checkInvitation, createInvitation, inviteQuotaStatus, revokeInvitation } from "@/server/services/invites";
import { db, makeUser, refreshViewer } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

let n = 0;
const form = (token: string, email?: string) => ({
  token,
  email: email ?? `applicant${++n}@example.com`,
  password: "long-enough-password",
  displayName: `申請者${n}`,
  fullName: "山田 太郎",
  affiliation: "テスト株式会社",
  relationship: "前職の同僚",
  introduction: "よろしくお願いします。",
});
const ctx = () => ({ ip: `10.0.0.${++n % 250}` });

/** 新規登録が実際に行われたことを確かめて userId を返す */
async function reg(token: string, email?: string) {
  const f = form(token, email);
  const { userId } = await register(d, f, ctx());
  expect(userId).toBeTruthy();
  return { f, userId: userId! };
}

/** 送信箱から、そのアドレス宛の最新メールに含まれるトークンを取り出す */
async function tokenFromMail(to: string, path: "/verify/") {
  const [m] = await d.select().from(mailOutbox).where(eq(mailOutbox.to, to)).orderBy(desc(mailOutbox.createdAt)).limit(1);
  const match = m?.body.match(new RegExp(`${path}([A-Za-z0-9_-]+)`));
  return match?.[1] ?? "";
}

describe("招待リンク", () => {
  it("一般会員は 30 日で 3 件まで。管理者は無制限", async () => {
    const m = await makeUser(d);
    for (let i = 0; i < 3; i++) await createInvitation(d, m.viewer, {});
    await expect(createInvitation(d, m.viewer, {})).rejects.toMatchObject({ code: "forbidden" });
    expect((await inviteQuotaStatus(d, m.viewer)).remaining).toBe(0);

    const a = await makeUser(d, { role: "admin" });
    for (let i = 0; i < 5; i++) await createInvitation(d, a.viewer, {});
  });

  it("一般会員は使用回数・期限を変えられない", async () => {
    const m = await makeUser(d);
    await expect(createInvitation(d, m.viewer, { maxUses: 5 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("DB にはトークンのハッシュだけが保存される", async () => {
    const m = await makeUser(d);
    const { token, invitation } = await createInvitation(d, m.viewer, {});
    const [row] = await d.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(row!.tokenHash).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("取り消し・期限切れ・招待者の停止で無効になる", async () => {
    const m = await makeUser(d);
    const a = await createInvitation(d, m.viewer, {});
    await revokeInvitation(d, m.viewer, a.invitation.id);
    expect((await checkInvitation(d, a.token)).ok).toBe(false);

    const b = await createInvitation(d, m.viewer, {});
    await d.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, b.invitation.id));
    expect((await checkInvitation(d, b.token)).ok).toBe(false);

    const c = await createInvitation(d, m.viewer, {});
    await d.update(users).set({ status: "suspended" }).where(eq(users.id, m.user.id));
    expect((await checkInvitation(d, c.token)).ok).toBe(false);
  });

  it("他人の招待は取り消せない（管理者は可）", async () => {
    const m = await makeUser(d);
    const other = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { invitation } = await createInvitation(d, m.viewer, {});
    await expect(revokeInvitation(d, other.viewer, invitation.id)).rejects.toMatchObject({ code: "forbidden" });
    await revokeInvitation(d, admin.viewer, invitation.id);
  });
});

describe("登録 → メール確認 → 審査 → 規約同意", () => {
  it("一連の流れで会員になり、招待の系譜が記録される", async () => {
    const inviter = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const { token } = await createInvitation(d, inviter.viewer, {});
    const { f, userId } = await reg(token);
    let me = await refreshViewer(d, userId);
    expect(me.status).toBe("unverified");
    expect(isMember(me)).toBe(false);
    // メール確認前は審査一覧に出ない
    expect((await listApplications(d, admin.viewer)).map((a) => a.userId)).not.toContain(userId);

    expect((await verifyEmail(d, await tokenFromMail(f.email, "/verify/"))).ok).toBe(true);
    expect((await refreshViewer(d, userId)).status).toBe("pending");
    const notes = await d.select().from(notifications).where(eq(notifications.userId, admin.user.id));
    expect(notes.some((x) => x.type === "application_submitted")).toBe(true);

    const apps = await listApplications(d, admin.viewer);
    const app = apps.find((a) => a.userId === userId)!;
    expect(app.inviterId).toBe(inviter.user.id);

    await decideApplication(d, admin.viewer, app.id, { kind: "approve" });
    me = await refreshViewer(d, userId);
    expect(me.status).toBe("active");
    expect(isMember(me)).toBe(false); // 規約同意まではコンテンツを見られない
    await acceptTerms(d, userId);
    expect(isMember(await refreshViewer(d, userId))).toBe(true);
  });

  it("確認リンクは 1 回しか使えない", async () => {
    const inviter = await makeUser(d);
    const { token } = await createInvitation(d, inviter.viewer, {});
    const { f } = await reg(token);
    const t = await tokenFromMail(f.email, "/verify/");
    expect((await verifyEmail(d, t)).ok).toBe(true);
    expect((await verifyEmail(d, t)).ok).toBe(false);
  });

  it("1 回限りの招待リンクは、同時に使われても 1 人しか登録できない", async () => {
    const inviter = await makeUser(d);
    const { token } = await createInvitation(d, inviter.viewer, {});
    const results = await Promise.allSettled([register(d, form(token), ctx()), register(d, form(token), ctx()), register(d, form(token), ctx())]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("登録済みのメールアドレスでも画面上は同じ応答。招待は消費され、本人にだけ通知が届く", async () => {
    const inviter = await makeUser(d, { role: "admin" });
    const existing = await makeUser(d);
    const { token, invitation } = await createInvitation(d, inviter.viewer, {});
    const res = await register(d, form(token, existing.user.email), ctx());
    expect(res.userId).toBeNull();
    const [inv] = await d.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(inv!.useCount).toBe(1); // 同じリンクで存在確認を繰り返せない
    const mails = await d.select().from(mailOutbox).where(eq(mailOutbox.to, existing.user.email));
    expect(mails.some((m) => m.subject.includes("登録の申し込み"))).toBe(true);
    const [u] = await d.select().from(users).where(eq(users.id, existing.user.id));
    expect(u!.passwordHash).toBe(existing.user.passwordHash); // 既存アカウントは一切変わらない
  });

  it("確認されずに 24 時間たった登録は、別の招待で登録し直せる（他人のアドレスの押さえ対策）", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const first = await createInvitation(d, admin.viewer, {});
    const { f, userId } = await reg(first.token);
    await d.update(users).set({ updatedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(users.id, userId));
    const second = await createInvitation(d, admin.viewer, {});
    const again = await register(d, { ...form(second.token, f.email) }, ctx());
    expect(again.userId).toBe(userId);
    const open = await d.select().from(applications).where(eq(applications.userId, userId));
    expect(open).toHaveLength(1); // 古い未審査の申請は置き換わる
  });

  it("一般会員は審査できない。二重承認はできない", async () => {
    const inviter = await makeUser(d);
    const admin = await makeUser(d, { role: "admin" });
    const member = await makeUser(d);
    const { token } = await createInvitation(d, inviter.viewer, {});
    const { f, userId } = await reg(token);
    await verifyEmail(d, await tokenFromMail(f.email, "/verify/"));
    const [app] = await d.select().from(applications).where(eq(applications.userId, userId));
    await expect(decideApplication(d, member.viewer, app!.id, { kind: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    await decideApplication(d, admin.viewer, app!.id, { kind: "approve" });
    await expect(decideApplication(d, admin.viewer, app!.id, { kind: "approve" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("却下されるとログインできず、30 日経つまで再申請できない", async () => {
    const inviter = await makeUser(d, { role: "admin" });
    const { token } = await createInvitation(d, inviter.viewer, {});
    const { f, userId } = await reg(token);
    await verifyEmail(d, await tokenFromMail(f.email, "/verify/"));
    const [app] = await d.select().from(applications).where(eq(applications.userId, userId));
    await decideApplication(d, inviter.viewer, app!.id, { kind: "reject", reasonKey: "unknown_relation" });

    expect(await login(d, { email: f.email, password: f.password, ip: "1.1.1.1" })).toMatchObject({ ok: false, reason: "rejected" });
    const mails = await d.select().from(mailOutbox).where(eq(mailOutbox.to, f.email));
    expect(mails.some((m) => m.subject.includes("結果"))).toBe(true);

    const again = await createInvitation(d, inviter.viewer, {});
    expect((await register(d, { ...form(again.token, f.email) }, ctx())).userId).toBeNull();
    expect((await refreshViewer(d, userId)).status).toBe("rejected");

    await d.update(users).set({ rejectedAt: new Date(Date.now() - 31 * 86400_000) }).where(eq(users.id, userId));
    const third = await createInvitation(d, inviter.viewer, {});
    const res = await register(d, form(third.token, f.email), ctx());
    expect(res.userId).toBe(userId);
    expect((await refreshViewer(d, userId)).status).toBe("unverified");
  });

  it("保留にしても申請中のまま審査一覧に残る", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const { token } = await createInvitation(d, admin.viewer, {});
    const { f, userId } = await reg(token);
    await verifyEmail(d, await tokenFromMail(f.email, "/verify/"));
    const [app] = await d.select().from(applications).where(eq(applications.userId, userId));
    await decideApplication(d, admin.viewer, app!.id, { kind: "hold", note: "招待者に確認中" });
    const open = await listApplications(d, admin.viewer);
    expect(open.find((a) => a.id === app!.id)?.status).toBe("on_hold");
  });

  it("EMAIL_VERIFICATION=off なら、確認メールなしで申請中になり管理者に届く", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const { token } = await createInvitation(d, admin.viewer, {});
    process.env.EMAIL_VERIFICATION = "off";
    try {
      const { f, userId } = await reg(token);
      expect((await refreshViewer(d, userId)).status).toBe("pending");
      expect(await tokenFromMail(f.email, "/verify/")).toBe("");
      expect((await listApplications(d, admin.viewer)).map((a) => a.userId)).toContain(userId);
    } finally {
      delete process.env.EMAIL_VERIFICATION;
    }
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { auditLogs, comments, notifications, posts, sessions, users } from "@/server/db/schema";
import { reinstateUser, setRole, suspendUser, listAuditLogs, setInviteQuota } from "@/server/services/admin";
import { createSession, login, userFromSession } from "@/server/services/auth";
import { addComment, getPost } from "@/server/services/posts";
import { createReport, getCase, listOpenCases, resolveCase } from "@/server/services/reports";
import { withdraw } from "@/server/services/members";
import { requestFriend, respondFriend, relationship } from "@/server/services/friends";
import { db, makeUser, PASSWORD, rawPost } from "./helpers";

let d: Db;
beforeAll(async () => {
  d = await db();
});

describe("通報と自動非表示", () => {
  it("別々の 3 人から通報されると自動で非表示。同じ人の二重通報は数えない", async () => {
    const author = await makeUser(d);
    const p = await rawPost(d, author.user.id);
    const [r1, r2, r3] = await Promise.all([makeUser(d), makeUser(d), makeUser(d)]);
    await createReport(d, r1!.viewer, { targetType: "post", targetId: p.id, reason: "spam" });
    expect((await createReport(d, r1!.viewer, { targetType: "post", targetId: p.id, reason: "spam" })).duplicated).toBe(true);
    await createReport(d, r2!.viewer, { targetType: "post", targetId: p.id, reason: "spam" });
    expect(await getPost(d, r3!.viewer, p.id)).not.toBeNull();
    const res = await createReport(d, r3!.viewer, { targetType: "post", targetId: p.id, reason: "harassment" });
    expect(res.autoHidden).toBe(true);
    const reader = await makeUser(d);
    expect(await getPost(d, reader.viewer, p.id)).toBeNull();
    const logs = await d.select().from(auditLogs).where(and(eq(auditLogs.action, "post.auto_hide"), eq(auditLogs.targetId, p.id)));
    expect(logs).toHaveLength(1);
  });

  it("「問題なし」で処理すると自動非表示が解除され、通報者に結果が届く", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const author = await makeUser(d);
    const p = await rawPost(d, author.user.id);
    const reporters = await Promise.all([makeUser(d), makeUser(d), makeUser(d)]);
    for (const r of reporters) await createReport(d, r.viewer, { targetType: "post", targetId: p.id, reason: "spam" });
    await resolveCase(d, admin.viewer, { targetType: "post", targetId: p.id, resolution: "dismissed" });
    const [row] = await d.select().from(posts).where(eq(posts.id, p.id));
    expect(row!.hiddenAt).toBeNull();
    const n = await d.select().from(notifications).where(and(eq(notifications.userId, reporters[0]!.user.id), eq(notifications.type, "report_resolved")));
    expect(n).toHaveLength(1);
  });

  it("管理者が通報内容を開くと監査ログに残る。一般会員は開けない", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const member = await makeUser(d);
    const author = await makeUser(d);
    const p = await rawPost(d, author.user.id, { visibility: "members" });
    await createReport(d, member.viewer, { targetType: "post", targetId: p.id, reason: "privacy" });
    await expect(getCase(d, member.viewer, "post", p.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listOpenCases(d, member.viewer)).rejects.toMatchObject({ code: "forbidden" });
    const c = await getCase(d, admin.viewer, "post", p.id);
    expect(c.content?.body).toBe(p.body);
    const logs = await d.select().from(auditLogs).where(and(eq(auditLogs.action, "report.view_content"), eq(auditLogs.targetId, p.id)));
    expect(logs[0]?.actorId).toBe(admin.user.id);
  });

  it("「投稿者を停止」は理由必須。停止するとセッションが消え、ログインもできない", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const author = await makeUser(d);
    const reporter = await makeUser(d);
    const p = await rawPost(d, author.user.id);
    const { token } = await createSession(d, author.user.id);
    await createReport(d, reporter.viewer, { targetType: "post", targetId: p.id, reason: "harassment" });
    await expect(resolveCase(d, admin.viewer, { targetType: "post", targetId: p.id, resolution: "suspended" })).rejects.toMatchObject({ code: "invalid" });
    await resolveCase(d, admin.viewer, { targetType: "post", targetId: p.id, resolution: "suspended", note: "度重なる嫌がらせ" });
    expect(await userFromSession(d, token)).toBeNull();
    expect(await login(d, { email: author.user.email, password: PASSWORD, ip: "2.2.2.2" })).toMatchObject({ ok: false, reason: "suspended" });
    const [row] = await d.select().from(posts).where(eq(posts.id, p.id));
    expect(row!.hiddenReason).toBe("moderation");
  });

  it("コメントも 3 件の通報で自動非表示になる", async () => {
    const author = await makeUser(d);
    const commenter = await makeUser(d);
    const p = await rawPost(d, author.user.id);
    const { id } = await addComment(d, commenter.viewer, { postId: p.id, body: "不適切なコメント" });
    for (const r of await Promise.all([makeUser(d), makeUser(d), makeUser(d)])) {
      await createReport(d, r.viewer, { targetType: "comment", targetId: id, reason: "inappropriate" });
    }
    const [c] = await d.select().from(comments).where(eq(comments.id, id));
    expect(c!.hiddenReason).toBe("auto");
  });
});

describe("管理権限の境界", () => {
  it("管理者はオーナー・他の管理者・自分を停止できない。オーナーは管理者を停止できる", async () => {
    const owner = await makeUser(d, { role: "owner" });
    const admin = await makeUser(d, { role: "admin" });
    const admin2 = await makeUser(d, { role: "admin" });
    await expect(suspendUser(d, admin.viewer, owner.user.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(suspendUser(d, admin.viewer, admin2.user.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    await expect(suspendUser(d, admin.viewer, admin.user.id, "x")).rejects.toMatchObject({ code: "forbidden" });
    await suspendUser(d, owner.viewer, admin2.user.id, "権限の乱用");
    await reinstateUser(d, owner.viewer, admin2.user.id);
  });

  it("停止理由は必須", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const m = await makeUser(d);
    await expect(suspendUser(d, admin.viewer, m.user.id, "  ")).rejects.toMatchObject({ code: "invalid" });
  });

  it("管理者の任命はオーナーだけ。一般会員は招待枠を変えられない", async () => {
    const owner = await makeUser(d, { role: "owner" });
    const admin = await makeUser(d, { role: "admin" });
    const m = await makeUser(d);
    await expect(setRole(d, admin.viewer, m.user.id, "admin")).rejects.toMatchObject({ code: "forbidden" });
    await setRole(d, owner.viewer, m.user.id, "admin");
    const [u] = await d.select().from(users).where(eq(users.id, m.user.id));
    expect(u!.role).toBe("admin");
    const other = await makeUser(d);
    await expect(setInviteQuota(d, other.viewer, m.user.id, 10)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("監査ログは書き換え・削除できない（DB トリガー）", async () => {
    const admin = await makeUser(d, { role: "admin" });
    const logs = await listAuditLogs(d, admin.viewer, 1);
    expect(logs.length).toBeGreaterThan(0);
    await expect(d.update(auditLogs).set({ action: "tampered" })).rejects.toThrow();
    await expect(d.delete(auditLogs)).rejects.toThrow();
  });
});

describe("ログイン", () => {
  it("5 回失敗するとロックされ、正しいパスワードでも入れない", async () => {
    const m = await makeUser(d);
    for (let i = 0; i < 5; i++) {
      expect(await login(d, { email: m.user.email, password: "wrong-password", ip: "3.3.3.3" })).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(await login(d, { email: m.user.email, password: PASSWORD, ip: "3.3.3.3" })).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("存在しないメールと誤ったパスワードは同じ応答", async () => {
    const m = await makeUser(d);
    const a = await login(d, { email: "nobody@example.com", password: "x", ip: "4.4.4.4" });
    const b = await login(d, { email: m.user.email, password: "x", ip: "4.4.4.5" });
    expect(a).toEqual(b);
  });

  it("メールアドレスの大文字小文字は区別しない。セッションはハッシュで保存", async () => {
    const m = await makeUser(d);
    const res = await login(d, { email: m.user.email.toUpperCase(), password: PASSWORD, ip: "5.5.5.5" });
    expect(res.ok).toBe(true);
    if (res.ok !== true) return;
    const rows = await d.select().from(sessions).where(eq(sessions.userId, m.user.id));
    expect(rows.every((r) => r.tokenHash !== res.token)).toBe(true);
  });
});

describe("友達と退会", () => {
  it("友達申請 → 承認で相互に友達になる。相手から申請済みなら自動承認", async () => {
    const a = await makeUser(d);
    const b = await makeUser(d);
    await requestFriend(d, a.viewer, b.user.id);
    expect(await relationship(d, a.viewer, b.user.id)).toBe("outgoing");
    expect(await relationship(d, b.viewer, a.user.id)).toBe("incoming");
    await respondFriend(d, b.viewer, a.user.id, true);
    expect(await relationship(d, a.viewer, b.user.id)).toBe("friends");

    const c = await makeUser(d);
    await requestFriend(d, c.viewer, a.user.id);
    await requestFriend(d, a.viewer, c.user.id); // 逆向きの申請 → 承認扱い
    expect(await relationship(d, a.viewer, c.user.id)).toBe("friends");
  });

  it("退会（匿名化）：投稿は匿名で残り、メールは解放、ログイン不可", async () => {
    const m = await makeUser(d);
    const reader = await makeUser(d);
    const p = await rawPost(d, m.user.id);
    await withdraw(d, m.viewer, { password: PASSWORD, mode: "anonymize" });
    const seen = await getPost(d, reader.viewer, p.id);
    expect(seen?.author.displayName).toBe("退会したメンバー");
    const [u] = await d.select().from(users).where(eq(users.id, m.user.id));
    expect(u!.email).not.toBe(m.user.email);
    expect((await login(d, { email: m.user.email, password: PASSWORD, ip: "6.6.6.6" })).ok).toBe(false);
  });

  it("退会（削除）：投稿も見えなくなる。パスワード違いでは退会できない", async () => {
    const m = await makeUser(d);
    const reader = await makeUser(d);
    const p = await rawPost(d, m.user.id);
    await expect(withdraw(d, m.viewer, { password: "wrong", mode: "delete" })).rejects.toMatchObject({ code: "invalid" });
    await withdraw(d, m.viewer, { password: PASSWORD, mode: "delete" });
    expect(await getPost(d, reader.viewer, p.id)).toBeNull();
  });

  it("オーナーは退会できない", async () => {
    const o = await makeUser(d, { role: "owner" });
    await expect(withdraw(d, o.viewer, { password: PASSWORD, mode: "delete" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

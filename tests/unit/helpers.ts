import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { friendships, posts, profiles, userMfa, users, type User } from "@/server/db/schema";
import { hashPassword } from "@/server/lib/password";
import { seal } from "@/server/lib/secretbox";
import { newTotpSecret } from "@/server/lib/totp";
import { toViewer, type Viewer } from "@/server/lib/viewer";
import { sealAad } from "@/server/services/mfa";

export const PASSWORD = "correct-horse-battery";
let pwHash: Promise<string> | undefined;
let seq = 0;

export async function db(): Promise<Db> {
  return getDb();
}

/**
 * テスト用の会員を直接作る（既定：承認済み・規約同意済みの一般会員）。
 * 管理者は既定で 2 段階認証を有効にしておく（mfa: false で未設定の管理者を作れる）
 */
export async function makeUser(
  d: Db,
  o: Partial<Pick<User, "role" | "status" | "displayName" | "email" | "invitedById">> & { terms?: boolean; mfa?: boolean } = {},
): Promise<{ user: User; viewer: Viewer; totpSecret?: string }> {
  pwHash ??= hashPassword(PASSWORD);
  seq += 1;
  const status = o.status ?? "active";
  const [user] = await d
    .insert(users)
    .values({
      email: o.email ?? `user${seq}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      passwordHash: await pwHash,
      displayName: o.displayName ?? `会員${seq}`,
      role: o.role ?? "member",
      status,
      invitedById: o.invitedById ?? null,
      emailVerifiedAt: new Date(),
      approvedAt: status === "active" ? new Date(Date.now() - 30 * 86400_000) : null,
      termsAcceptedAt: status === "active" && o.terms !== false ? new Date() : null,
    })
    .returning();
  await d.insert(profiles).values({ userId: user!.id });
  const mfa = o.mfa ?? (user!.role !== "member");
  const totpSecret = mfa ? await enableMfaDirect(d, user!.id) : undefined;
  return { user: user!, viewer: toViewer(user!, { mfa }), totpSecret };
}

/** 画面を通さずに 2 段階認証を有効にし、鍵を返す */
export async function enableMfaDirect(d: Db, userId: string): Promise<string> {
  const secret = newTotpSecret();
  await d.insert(userMfa).values({ userId, secretEnc: seal(secret, sealAad(userId)), enabledAt: new Date() });
  return secret;
}

export async function refreshViewer(d: Db, id: string): Promise<Viewer> {
  const [row] = await d.select({ u: users, mfaAt: userMfa.enabledAt }).from(users).leftJoin(userMfa, eq(userMfa.userId, users.id)).where(eq(users.id, id));
  return toViewer(row!.u, { mfa: row!.mfaAt != null });
}

export async function befriend(d: Db, a: string, b: string) {
  await d.insert(friendships).values({ requesterId: a, addresseeId: b, status: "accepted", respondedAt: new Date() });
}

export async function rawPost(d: Db, authorId: string, o: Partial<typeof posts.$inferInsert> = {}) {
  const [p] = await d.insert(posts).values({ authorId, body: o.body ?? "hello", visibility: o.visibility ?? "members", ...o }).returning();
  return p!;
}

import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/server/db/client";
import { friendships, posts, profiles, users, type User } from "@/server/db/schema";
import { hashPassword } from "@/server/lib/password";
import { toViewer, type Viewer } from "@/server/lib/viewer";

export const PASSWORD = "correct-horse-battery";
let pwHash: Promise<string> | undefined;
let seq = 0;

export async function db(): Promise<Db> {
  return getDb();
}

/** テスト用の会員を直接作る（既定：承認済み・規約同意済みの一般会員） */
export async function makeUser(
  d: Db,
  o: Partial<Pick<User, "role" | "status" | "displayName" | "email" | "invitedById">> & { terms?: boolean } = {},
): Promise<{ user: User; viewer: Viewer }> {
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
  return { user: user!, viewer: toViewer(user!) };
}

export async function refreshViewer(d: Db, id: string): Promise<Viewer> {
  const [u] = await d.select().from(users).where(eq(users.id, id));
  return toViewer(u!);
}

export async function befriend(d: Db, a: string, b: string) {
  await d.insert(friendships).values({ requesterId: a, addresseeId: b, status: "accepted", respondedAt: new Date() });
}

export async function rawPost(d: Db, authorId: string, o: Partial<typeof posts.$inferInsert> = {}) {
  const [p] = await d.insert(posts).values({ authorId, body: o.body ?? "hello", visibility: o.visibility ?? "members", ...o }).returning();
  return p!;
}

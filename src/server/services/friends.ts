import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { friendships, profiles, users } from "../db/schema";
import { conflict, invalid, notFound } from "../lib/errors";
import { assertMember } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { notify } from "./notifications";

export type Relationship = "self" | "friends" | "outgoing" | "incoming" | "none";

const pair = (a: string, b: string) =>
  or(
    and(eq(friendships.requesterId, a), eq(friendships.addresseeId, b)),
    and(eq(friendships.requesterId, b), eq(friendships.addresseeId, a)),
  );

export async function relationship(db: Db, viewer: Viewer, otherId: string): Promise<Relationship> {
  if (otherId === viewer.id) return "self";
  const [f] = await db.select().from(friendships).where(pair(viewer.id, otherId)).limit(1);
  if (!f) return "none";
  if (f.status === "accepted") return "friends";
  return f.requesterId === viewer.id ? "outgoing" : "incoming";
}

async function activeMember(db: Db, id: string) {
  if (!z.uuid().safeParse(id).success) throw notFound();
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.status, "active")));
  if (!u) throw notFound("会員が見つかりません。");
  return u;
}

/** 友達申請。相手からの申請が来ていれば、そのまま承認扱いにする */
export async function requestFriend(db: Db, viewer: Viewer, otherId: string) {
  assertMember(viewer);
  if (otherId === viewer.id) throw invalid("自分には友達申請できません。");
  await activeMember(db, otherId);
  const rel = await relationship(db, viewer, otherId);
  if (rel === "friends" || rel === "outgoing") return;
  if (rel === "incoming") return respondFriend(db, viewer, otherId, true);
  await db.transaction(async (tx) => {
    await tx.insert(friendships).values({ requesterId: viewer.id, addresseeId: otherId }).onConflictDoNothing();
    await notify(tx, { userId: otherId, type: "friend_request", actorId: viewer.id });
  });
}

export async function respondFriend(db: Db, viewer: Viewer, requesterId: string, accept: boolean) {
  assertMember(viewer);
  if (!z.uuid().safeParse(requesterId).success) throw notFound();
  const where = and(
    eq(friendships.requesterId, requesterId),
    eq(friendships.addresseeId, viewer.id),
    eq(friendships.status, "pending"),
  );
  if (!accept) {
    await db.delete(friendships).where(where);
    return;
  }
  await db.transaction(async (tx) => {
    const [f] = await tx.update(friendships).set({ status: "accepted", respondedAt: new Date() }).where(where).returning();
    if (!f) throw conflict("友達申請が見つかりません。");
    await notify(tx, { userId: requesterId, type: "friend_accepted", actorId: viewer.id });
  });
}

/** 申請の取り消し・友達の解除（どちら向きの行でも削除） */
export async function removeFriend(db: Db, viewer: Viewer, otherId: string) {
  assertMember(viewer);
  if (!z.uuid().safeParse(otherId).success) throw notFound();
  await db.delete(friendships).where(pair(viewer.id, otherId));
}

export async function listFriends(db: Db, viewer: Viewer) {
  assertMember(viewer);
  const otherId = sql<string>`CASE WHEN ${friendships.requesterId} = ${viewer.id} THEN ${friendships.addresseeId} ELSE ${friendships.requesterId} END`;
  const rows = await db
    .select({
      otherId,
      status: friendships.status,
      requesterId: friendships.requesterId,
      createdAt: friendships.createdAt,
    })
    .from(friendships)
    .where(or(eq(friendships.requesterId, viewer.id), eq(friendships.addresseeId, viewer.id)))
    .orderBy(desc(friendships.createdAt));
  const ids = rows.map((r) => r.otherId);
  const people = ids.length
    ? await db
        .select({ id: users.id, displayName: users.displayName, status: users.status, affiliation: profiles.affiliation, avatarMediaId: profiles.avatarMediaId })
        .from(users)
        .leftJoin(profiles, eq(profiles.userId, users.id))
        .where(and(inArray(users.id, ids), eq(users.status, "active")))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const out = { friends: [] as typeof people, incoming: [] as typeof people, outgoing: [] as typeof people };
  for (const r of rows) {
    const p = byId.get(r.otherId);
    if (!p) continue;
    if (r.status === "accepted") out.friends.push(p);
    else if (r.requesterId === viewer.id) out.outgoing.push(p);
    else out.incoming.push(p);
  }
  return out;
}

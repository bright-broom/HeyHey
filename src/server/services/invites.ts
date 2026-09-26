import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, DbOrTx } from "../db/client";
import { invitations, users } from "../db/schema";
import { forbidden, notFound } from "../lib/errors";
import { assertMember, INVITE_TTL_DAYS, isAdmin, monthlyInviteQuota } from "../lib/policy";
import { hashToken, newToken } from "../lib/tokens";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { appUrl } from "./mailer";

const DAY = 24 * 60 * 60 * 1000;
/** 招待枠は「直近 30 日で何件発行したか」で数える（取り消した招待も数に含める） */
const QUOTA_WINDOW_DAYS = 30;

export async function inviteQuotaStatus(db: DbOrTx, viewer: Viewer) {
  assertMember(viewer);
  const [me] = await db
    .select({ override: users.inviteQuotaOverride })
    .from(users)
    .where(eq(users.id, viewer.id));
  const quota = monthlyInviteQuota(viewer.role, me?.override ?? null);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(invitations)
    .where(
      and(
        eq(invitations.createdById, viewer.id),
        gt(invitations.createdAt, new Date(Date.now() - QUOTA_WINDOW_DAYS * DAY)),
      ),
    );
  const used = row?.n ?? 0;
  return { quota, used, remaining: Math.max(0, quota - used) };
}

const createSchema = z.object({
  note: z.string().trim().max(100, "メモは 100 文字以内です。").default(""),
  maxUses: z.coerce.number().int().min(1).max(50).default(1),
  ttlDays: z.coerce.number().int().min(1).max(30).default(INVITE_TTL_DAYS),
});

/** 招待リンクを発行する。URL 用のトークンはこの戻り値でしか得られない（DB はハッシュのみ） */
export async function createInvitation(db: Db, viewer: Viewer, raw: z.input<typeof createSchema>) {
  assertMember(viewer);
  const input = createSchema.parse(raw);
  // 複数回使える招待・長い有効期限は管理者だけ
  if (!isAdmin(viewer) && (input.maxUses !== 1 || input.ttlDays !== INVITE_TTL_DAYS)) {
    throw forbidden("使用回数や有効期限の変更は管理者のみ行えます。");
  }
  return db.transaction(async (tx) => {
    // 同時発行で枠を超えないよう、発行者の行をロックしてから数える
    await tx.select({ id: users.id }).from(users).where(eq(users.id, viewer.id)).for("update");
    const q = await inviteQuotaStatus(tx, viewer);
    if (q.remaining <= 0) throw forbidden(`招待枠（30 日あたり ${q.quota} 件）を使い切っています。`);
    const token = newToken();
    const [inv] = await tx
      .insert(invitations)
      .values({
        tokenHash: hashToken(token),
        createdById: viewer.id,
        note: input.note,
        maxUses: input.maxUses,
        expiresAt: new Date(Date.now() + input.ttlDays * DAY),
      })
      .returning();
    await audit(tx, { actorId: viewer.id, action: "invite.create", targetType: "invitation", targetId: inv!.id, meta: { maxUses: input.maxUses } });
    return { invitation: inv!, token, url: appUrl(`/join/${token}`) };
  });
}

export async function listMyInvitations(db: Db, viewer: Viewer) {
  assertMember(viewer);
  return db
    .select({
      id: invitations.id,
      note: invitations.note,
      maxUses: invitations.maxUses,
      useCount: invitations.useCount,
      expiresAt: invitations.expiresAt,
      revokedAt: invitations.revokedAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.createdById, viewer.id))
    .orderBy(desc(invitations.createdAt))
    .limit(100);
}

/** 本人は自分の招待を、管理者はすべての招待を即時失効できる */
export async function revokeInvitation(db: Db, viewer: Viewer, invitationId: string) {
  assertMember(viewer);
  const [inv] = await db.select().from(invitations).where(eq(invitations.id, invitationId)).limit(1);
  if (!inv) throw notFound();
  if (inv.createdById !== viewer.id && !isAdmin(viewer)) throw forbidden();
  if (inv.revokedAt) return;
  await db.transaction(async (tx) => {
    await tx
      .update(invitations)
      .set({ revokedAt: new Date(), revokedById: viewer.id })
      .where(eq(invitations.id, invitationId));
    await audit(tx, { actorId: viewer.id, action: "invite.revoke", targetType: "invitation", targetId: invitationId });
  });
}

export type InvitationCheck =
  | { ok: true; invitation: typeof invitations.$inferSelect; inviterName: string }
  | { ok: false; message: string };

/**
 * 招待トークンの有効性確認。理由は「無効」の 1 種類にまとめて返し、
 * 期限切れ・使用済み・存在しないを外部から区別できないようにする。
 */
export async function checkInvitation(db: DbOrTx, token: string): Promise<InvitationCheck> {
  const bad = { ok: false as const, message: "この招待リンクは無効です。使用済み、期限切れ、または取り消された可能性があります。" };
  if (!token || token.length > 200) return bad;
  const [row] = await db
    .select({ inv: invitations, inviterName: users.displayName, inviterStatus: users.status })
    .from(invitations)
    .innerJoin(users, eq(users.id, invitations.createdById))
    .where(eq(invitations.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return bad;
  const { inv } = row;
  if (inv.revokedAt || inv.expiresAt <= new Date() || inv.useCount >= inv.maxUses) return bad;
  // 招待した人が停止・退会したら、その人の未使用の招待も使えなくする
  if (row.inviterStatus !== "active") return bad;
  return { ok: true, invitation: inv, inviterName: row.inviterName };
}

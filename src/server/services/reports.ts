import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db, Tx } from "../db/client";
import { comments, media, posts, profiles, reports, users } from "../db/schema";
import { conflict, invalid, notFound } from "../lib/errors";
import { assertAdmin, assertMember, AUTO_HIDE_REPORT_THRESHOLD } from "../lib/policy";
import { visibleComment, visiblePost } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";
import { audit } from "./audit";
import { suspendUser } from "./admin";
import { notify, notifyAdmins } from "./notifications";

export const REPORT_REASONS = {
  spam: "スパム・宣伝",
  harassment: "嫌がらせ・攻撃的な内容",
  inappropriate: "不適切な内容",
  privacy: "個人情報・プライバシーの侵害",
  other: "その他",
} as const;
export const RESOLUTIONS = {
  dismissed: "問題なし",
  hidden: "非表示",
  warned: "警告",
  suspended: "投稿者を停止",
} as const;
type TargetType = "post" | "comment" | "user";

const reportSchema = z.object({
  targetType: z.enum(["post", "comment", "user"]),
  targetId: z.uuid(),
  reason: z.enum(["spam", "harassment", "inappropriate", "privacy", "other"], { message: "通報の理由を選んでください。" }),
  detail: z.string().trim().max(1000, "詳細は 1000 文字以内です。").default(""),
});

/**
 * 通報。自分が見えている対象だけを通報でき、同じ人が同じ対象を二重に通報しても 1 件扱い。
 * 別々の会員からの通報が 3 件に達した投稿・コメントは自動で一時非表示にする。
 */
export async function createReport(db: Db, viewer: Viewer, raw: z.input<typeof reportSchema>) {
  assertMember(viewer);
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "入力内容を確認してください。");
  const input = parsed.data;

  let targetUserId: string | undefined;
  if (input.targetType === "post") {
    const [p] = await db.select({ authorId: posts.authorId }).from(posts).where(and(eq(posts.id, input.targetId), visiblePost(viewer.id)));
    targetUserId = p?.authorId;
  } else if (input.targetType === "comment") {
    const [c] = await db.select({ authorId: comments.authorId }).from(comments).where(and(eq(comments.id, input.targetId), visibleComment(viewer.id)));
    targetUserId = c?.authorId;
  } else {
    const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, input.targetId), eq(users.status, "active")));
    targetUserId = u?.id;
  }
  if (!targetUserId) throw notFound("通報の対象が見つかりません。");
  if (targetUserId === viewer.id) throw invalid("自分自身や自分の投稿は通報できません。");

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(reports)
      .values({ reporterId: viewer.id, targetType: input.targetType, targetId: input.targetId, targetUserId: targetUserId!, reason: input.reason, detail: input.detail })
      .onConflictDoNothing()
      .returning({ id: reports.id });
    if (!inserted.length) return { duplicated: true, autoHidden: false };

    let autoHidden = false;
    if (input.targetType !== "user") {
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(distinct ${reports.reporterId})::int` })
        .from(reports)
        .where(and(eq(reports.targetType, input.targetType), eq(reports.targetId, input.targetId), eq(reports.status, "open")));
      if (n >= AUTO_HIDE_REPORT_THRESHOLD) {
        const table = input.targetType === "post" ? posts : comments;
        const updated = await tx
          .update(table)
          .set({ hiddenAt: new Date(), hiddenReason: "auto" })
          .where(and(eq(table.id, input.targetId), isNull(table.hiddenAt)))
          .returning({ id: table.id });
        if (updated.length) {
          autoHidden = true;
          await audit(tx, { actorId: null, action: `${input.targetType}.auto_hide`, targetType: input.targetType, targetId: input.targetId, meta: { reports: n } });
        }
      }
    }
    await notifyAdmins(tx, { type: "report_submitted", actorId: null, data: { targetType: input.targetType } });
    return { duplicated: false, autoHidden };
  });
}

/** 未処理の通報を対象ごとにまとめた一覧（本文は含めない。中身は詳細画面で監査ログ付きで見る） */
export async function listOpenCases(db: Db, viewer: Viewer) {
  assertAdmin(viewer);
  return db
    .select({
      targetType: reports.targetType,
      targetId: reports.targetId,
      targetUserId: reports.targetUserId,
      targetUserName: users.displayName,
      count: sql<number>`count(*)::int`,
      reasons: sql<string[]>`array_agg(distinct ${reports.reason})`,
      firstAt: sql<Date>`min(${reports.createdAt})`,
      lastAt: sql<Date>`max(${reports.createdAt})`,
    })
    .from(reports)
    .innerJoin(users, eq(users.id, reports.targetUserId))
    .where(eq(reports.status, "open"))
    .groupBy(reports.targetType, reports.targetId, reports.targetUserId, users.displayName)
    .orderBy(sql`min(${reports.createdAt}) asc`)
    .limit(200);
}

/**
 * 通報された対象の中身を管理者が確認する。「友達のみ」の投稿でも見られるが、
 * 閲覧した事実を監査ログに残す（要件 5 章）。
 */
export async function getCase(db: Db, viewer: Viewer, targetType: TargetType, targetId: string) {
  assertAdmin(viewer);
  if (!z.uuid().safeParse(targetId).success || !["post", "comment", "user"].includes(targetType)) throw notFound();
  const rows = await db
    .select({ r: reports, reporterName: users.displayName })
    .from(reports)
    .innerJoin(users, eq(users.id, reports.reporterId))
    .where(and(eq(reports.targetType, targetType), eq(reports.targetId, targetId)))
    .orderBy(desc(reports.createdAt));
  if (!rows.length) throw notFound("この対象への通報はありません。");

  let content: { body: string; hidden: boolean; visibility?: string; mediaIds?: string[]; postId?: string } | null = null;
  if (targetType === "post") {
    const [p] = await db.select().from(posts).where(eq(posts.id, targetId));
    if (p) {
      const m = await db.select({ id: media.id }).from(media).where(eq(media.postId, p.id));
      content = { body: p.body, hidden: !!p.hiddenAt, visibility: p.visibility, mediaIds: m.map((x) => x.id), postId: p.id };
    }
  } else if (targetType === "comment") {
    const [c] = await db.select().from(comments).where(eq(comments.id, targetId));
    if (c) content = { body: c.body, hidden: !!c.hiddenAt, postId: c.postId };
  } else {
    const [pr] = await db.select().from(profiles).where(eq(profiles.userId, targetId));
    content = { body: `所属：${pr?.affiliation ?? ""}\n自己紹介：${pr?.bio ?? ""}`, hidden: false };
  }
  const targetUserId = rows[0]!.r.targetUserId;
  const [author] = await db.select({ id: users.id, displayName: users.displayName, status: users.status, role: users.role }).from(users).where(eq(users.id, targetUserId));
  await audit(db, { actorId: viewer.id, action: "report.view_content", targetType, targetId });
  return {
    reports: rows.map(({ r, reporterName }) => ({ ...r, reporterName })),
    content,
    author: author!,
    open: rows.some((x) => x.r.status === "open"),
  };
}

async function setHidden(tx: Tx, targetType: TargetType, targetId: string, hidden: boolean, reason: string) {
  if (targetType === "user") return;
  const table = targetType === "post" ? posts : comments;
  await tx
    .update(table)
    .set(hidden ? { hiddenAt: new Date(), hiddenReason: reason } : { hiddenAt: null, hiddenReason: null })
    .where(eq(table.id, targetId));
}

/** 対象単位で通報をまとめて処理し、通報者と投稿者に結果を通知する */
export async function resolveCase(
  db: Db,
  viewer: Viewer,
  input: { targetType: TargetType; targetId: string; resolution: string; note?: string },
) {
  assertAdmin(viewer);
  if (!(input.resolution in RESOLUTIONS)) throw invalid("処理内容を選んでください。");
  const resolution = input.resolution as keyof typeof RESOLUTIONS;
  const note = (input.note ?? "").trim().slice(0, 500);
  if (resolution === "suspended" && !note) throw invalid("停止する場合は理由を入力してください。");
  if (!z.uuid().safeParse(input.targetId).success) throw notFound();

  const open = await db
    .select()
    .from(reports)
    .where(and(eq(reports.targetType, input.targetType), eq(reports.targetId, input.targetId), eq(reports.status, "open")));
  if (!open.length) throw conflict("未処理の通報がありません。");
  const targetUserId = open[0]!.targetUserId;

  // 停止は既存の会員停止処理（権限チェック・セッション破棄・監査ログ込み）を使う
  if (resolution === "suspended") await suspendUser(db, viewer, targetUserId, note);

  await db.transaction(async (tx) => {
    if (resolution === "dismissed") {
      // 自動非表示だったものだけ戻す（管理者が手動で隠したものは触らない）
      if (input.targetType !== "user") {
        const table = input.targetType === "post" ? posts : comments;
        await tx.update(table).set({ hiddenAt: null, hiddenReason: null }).where(and(eq(table.id, input.targetId), eq(table.hiddenReason, "auto")));
      }
    } else if (resolution === "hidden" || resolution === "suspended") {
      await setHidden(tx, input.targetType, input.targetId, true, "moderation");
    }
    await tx
      .update(reports)
      .set({ status: "resolved", resolution, resolvedById: viewer.id, resolvedAt: new Date(), note: note || null })
      .where(inArray(reports.id, open.map((r) => r.id)));
    await audit(tx, {
      actorId: viewer.id,
      action: "report.resolve",
      targetType: input.targetType,
      targetId: input.targetId,
      reason: note || null,
      meta: { resolution, reports: open.length },
    });
    for (const reporterId of new Set(open.map((r) => r.reporterId))) {
      await notify(tx, { userId: reporterId, type: "report_resolved", actorId: null, data: { resolution: RESOLUTIONS[resolution] } });
    }
    if (resolution === "hidden" || resolution === "warned") {
      await notify(tx, {
        userId: targetUserId,
        type: "moderation",
        actorId: null,
        data: { resolution: RESOLUTIONS[resolution], targetType: input.targetType, note },
      });
    }
  });
}

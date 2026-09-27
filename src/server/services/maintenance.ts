import { and, eq, inArray, isNotNull, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  applications,
  comments,
  emailTokens,
  loginChallenges,
  mailOutbox,
  media,
  notifications,
  posts,
  rateLimits,
  reports,
  sessions,
  users,
} from "../db/schema";
import { PURGE_AFTER_DAYS, REVIEW_SLA_HOURS } from "../lib/policy";
import { recordActivitySnapshot } from "./activity";
import { audit } from "./audit";
import { budget, dispatchPendingNotificationEmails, isDigestDay, sendWeeklyDigests } from "./email-notify";
import { notifyAdmins } from "./notifications";
import { removeStoredFile } from "./storage";

/**
 * 毎日 1 回の定期処理（Vercel Cron → /api/cron/daily、ローカルは npm run maintenance）。
 * どの処理も何度流しても同じ結果になるように書く（失敗したら翌日にもう一度流れるだけ）。
 */
const DAY = 24 * 60 * 60 * 1000;

export type MaintenanceReport = {
  /** その日の利用状況を記録したか（同じ日の 2 回目以降は false） */
  activityRecorded: boolean;
  purgedPosts: number;
  erasedComments: number;
  purgedFiles: number;
  purgedWithdrawn: number;
  overdueNotified: number;
  notificationEmails: number;
  digests: number;
  expired: { sessions: number; challenges: number; tokens: number; rateLimits: number; mails: number };
};

export async function runDailyMaintenance(db: Db, now = new Date()): Promise<MaintenanceReport> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY);

  // 0) 利用状況を 1 日 1 行残す（片付けで数字が変わる前に。人数だけで、誰がかは残さない）
  const activityRecorded = await recordActivitySnapshot(db, now);

  // 未処理の通報がかかっているものは、対応が終わるまで消さない（本人が消しても証拠を残す）
  const postUnderReview = sql`EXISTS (SELECT 1 FROM ${reports} WHERE ${reports.status} = 'open' AND (
    (${reports.targetType} = 'post' AND ${reports.targetId} = ${posts.id}) OR
    (${reports.targetType} = 'comment' AND ${reports.targetId} IN (SELECT ${comments.id} FROM ${comments} WHERE ${comments.postId} = ${posts.id}))))`;
  const commentUnderReview = sql`EXISTS (SELECT 1 FROM ${reports} WHERE ${reports.status} = 'open' AND ${reports.targetType} = 'comment' AND ${reports.targetId} = ${comments.id})`;
  const postDoomed = and(isNotNull(posts.deletedAt), lt(posts.deletedAt, cutoff), sql`NOT ${postUnderReview}`);

  // 1) 削除から 30 日たった投稿を完全に消す（コメント・リアクション・画像の行は外部キーで一緒に消える）
  const doomedFiles = await db.select({ key: media.storageKey }).from(media).innerJoin(posts, eq(posts.id, media.postId)).where(postDoomed);
  const purgedPosts = await db.delete(posts).where(postDoomed).returning({ id: posts.id });

  // 2) 削除から 30 日たったコメントは、本文を消して「削除済み」の抜け殻だけ残す
  //    （返信がぶら下がっていることがあるので、行ごとは消さない）
  const erasedComments = await db
    .update(comments)
    .set({ body: "" })
    .where(and(isNotNull(comments.deletedAt), lt(comments.deletedAt, cutoff), sql`${comments.body} <> ''`, sql`NOT ${commentUnderReview}`))
    .returning({ id: comments.id });

  // 3) 退会から 30 日たった人の残りの個人情報を消す（申請内容・届いた通知）
  const withdrawn = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, "withdrawn"), isNotNull(users.withdrawnAt), lt(users.withdrawnAt, cutoff)));
  const withdrawnIds = withdrawn.map((w) => w.id);
  let purgedWithdrawn = 0;
  if (withdrawnIds.length) {
    const apps = await db.delete(applications).where(inArray(applications.userId, withdrawnIds)).returning({ id: applications.id });
    const notes = await db
      .delete(notifications)
      .where(or(inArray(notifications.userId, withdrawnIds), inArray(notifications.actorId, withdrawnIds)))
      .returning({ id: notifications.id });
    purgedWithdrawn = apps.length + notes.length;
  }

  // 4) 72 時間を超えて審査待ちの申請を、管理者に 1 回だけ再通知する
  const overdue = await db
    .select({ id: applications.id, userId: applications.userId, name: users.displayName })
    .from(applications)
    .innerJoin(users, eq(users.id, applications.userId))
    .where(
      and(
        eq(applications.status, "pending"),
        eq(users.status, "pending"),
        lt(applications.createdAt, new Date(now.getTime() - REVIEW_SLA_HOURS * 60 * 60 * 1000)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(notifications)
            .where(and(eq(notifications.type, "application_overdue"), sql`${notifications.data}->>'applicationId' = ${applications.id}::text`)),
        ),
      ),
    );
  for (const a of overdue) {
    await notifyAdmins(db, { type: "application_overdue", actorId: a.userId, data: { applicationId: a.id, name: a.name } });
  }

  // 5) 期限切れのデータを片付ける
  const expired = {
    sessions: (await db.delete(sessions).where(lt(sessions.expiresAt, now)).returning({ id: sessions.tokenHash })).length,
    challenges: (await db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, now)).returning({ id: loginChallenges.tokenHash })).length,
    tokens: (
      await db
        .delete(emailTokens)
        .where(or(lt(emailTokens.expiresAt, new Date(now.getTime() - 7 * DAY)), lt(emailTokens.usedAt, new Date(now.getTime() - 7 * DAY))))
        .returning({ id: emailTokens.tokenHash })
    ).length,
    rateLimits: (await db.delete(rateLimits).where(lt(rateLimits.windowStartedAt, new Date(now.getTime() - DAY))).returning({ key: rateLimits.key })).length,
    // 送信記録には宛先（メールアドレス）が残るので、30 日で消す
    mails: (await db.delete(mailOutbox).where(lt(mailOutbox.createdAt, cutoff)).returning({ id: mailOutbox.id })).length,
  };

  // 画像ファイルは DB から消し終えてから消す（ファイルだけ消えて行が残る、を避ける）
  for (const f of doomedFiles) await removeStoredFile(f.key).catch(() => undefined);

  // 6) メールは最後に、時間の上限付きで（送信の失敗や遅さで、ほかの片付けが止まらないように）
  const mailBudget = budget(35_000);
  let notificationEmails = 0;
  let digests = 0;
  try {
    notificationEmails = await dispatchPendingNotificationEmails(db, now, mailBudget);
    if (isDigestDay(now)) digests = await sendWeeklyDigests(db, now, mailBudget);
  } catch (e) {
    console.error("[maintenance] email step failed", e instanceof Error ? e.message : e);
  }

  const report: MaintenanceReport = {
    activityRecorded,
    purgedPosts: purgedPosts.length,
    erasedComments: erasedComments.length,
    purgedFiles: doomedFiles.length,
    purgedWithdrawn,
    overdueNotified: overdue.length,
    notificationEmails,
    digests,
    expired,
  };
  await audit(db, { actorId: null, action: "system.maintenance", targetType: "system", meta: report });
  return report;
}

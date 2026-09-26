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
  sessions,
  users,
} from "../db/schema";
import { PURGE_AFTER_DAYS, REVIEW_SLA_HOURS } from "../lib/policy";
import { audit } from "./audit";
import { notifyAdmins } from "./notifications";
import { removeStoredFile } from "./storage";

/**
 * 毎日 1 回の定期処理（Vercel Cron → /api/cron/daily、ローカルは npm run maintenance）。
 * どの処理も何度流しても同じ結果になるように書く（失敗したら翌日にもう一度流れるだけ）。
 */
const DAY = 24 * 60 * 60 * 1000;

export type MaintenanceReport = {
  purgedPosts: number;
  erasedComments: number;
  purgedFiles: number;
  purgedWithdrawn: number;
  overdueNotified: number;
  expired: { sessions: number; challenges: number; tokens: number; rateLimits: number; mails: number };
};

export async function runDailyMaintenance(db: Db, now = new Date()): Promise<MaintenanceReport> {
  const cutoff = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY);

  // 1) 削除から 30 日たった投稿を完全に消す（コメント・リアクション・画像の行は外部キーで一緒に消える）
  const doomedFiles = await db
    .select({ key: media.storageKey })
    .from(media)
    .innerJoin(posts, eq(posts.id, media.postId))
    .where(and(isNotNull(posts.deletedAt), lt(posts.deletedAt, cutoff)));
  const purgedPosts = await db
    .delete(posts)
    .where(and(isNotNull(posts.deletedAt), lt(posts.deletedAt, cutoff)))
    .returning({ id: posts.id });

  // 2) 削除から 30 日たったコメントは、本文を消して「削除済み」の抜け殻だけ残す
  //    （返信がぶら下がっていることがあるので、行ごとは消さない）
  const erasedComments = await db
    .update(comments)
    .set({ body: "" })
    .where(and(isNotNull(comments.deletedAt), lt(comments.deletedAt, cutoff), sql`${comments.body} <> ''`))
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

  const report: MaintenanceReport = {
    purgedPosts: purgedPosts.length,
    erasedComments: erasedComments.length,
    purgedFiles: doomedFiles.length,
    purgedWithdrawn,
    overdueNotified: overdue.length,
    expired,
  };
  await audit(db, { actorId: null, action: "system.maintenance", targetType: "system", meta: report });
  return report;
}

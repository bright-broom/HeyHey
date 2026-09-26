import { sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { rateLimits } from "../db/schema";

/**
 * 固定ウィンドウのレート制限。DB に置くので複数インスタンスでも共有できる。
 * 呼ぶたびに 1 回分を消費し、上限を超えていれば false を返す。
 */
export async function consume(db: DbOrTx, key: string, limit: number, windowSec: number): Promise<boolean> {
  const [row] = await db
    .insert(rateLimits)
    .values({ key, count: 1, windowStartedAt: new Date() })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.windowStartedAt} < now() - make_interval(secs => ${windowSec}) THEN 1 ELSE ${rateLimits.count} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${rateLimits.windowStartedAt} < now() - make_interval(secs => ${windowSec}) THEN now() ELSE ${rateLimits.windowStartedAt} END`,
      },
    })
    .returning({ count: rateLimits.count });
  return (row?.count ?? 0) <= limit;
}

export async function reset(db: DbOrTx, key: string): Promise<void> {
  await db.delete(rateLimits).where(sql`${rateLimits.key} = ${key}`);
}

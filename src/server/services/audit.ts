import type { DbOrTx } from "../db/client";
import { auditLogs } from "../db/schema";

export type AuditEntry = {
  actorId: string | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  reason?: string | null;
  meta?: Record<string, unknown>;
};

/** 追記専用の監査ログ。業務処理と同じトランザクションで書き、片方だけ残ることを防ぐ */
export async function audit(db: DbOrTx, e: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    actorId: e.actorId,
    action: e.action,
    targetType: e.targetType,
    targetId: e.targetId ?? null,
    reason: e.reason ?? null,
    meta: e.meta ?? {},
  });
}

import type { User } from "../db/schema";

/**
 * 「誰が見ているか」。すべてのサービス関数はこれを第 1 引数に取り、
 * 認可判定はここに入っている状態（毎リクエスト DB から読み直した値）だけで行う。
 */
export type Viewer = Pick<User, "id" | "role" | "status" | "displayName"> & { termsAccepted: boolean };

export function toViewer(u: User): Viewer {
  return {
    id: u.id,
    role: u.role,
    status: u.status,
    displayName: u.displayName,
    termsAccepted: u.termsAcceptedAt != null,
  };
}

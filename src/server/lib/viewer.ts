import type { User } from "../db/schema";

/**
 * 「誰が見ているか」。すべてのサービス関数はこれを第 1 引数に取り、
 * 認可判定はここに入っている状態（毎リクエスト DB から読み直した値）だけで行う。
 * mfa は 2 段階認証を有効にしているか。管理者の権限はこれが true のときだけ働く。
 */
export type Viewer = Pick<User, "id" | "role" | "status" | "displayName"> & { termsAccepted: boolean; mfa: boolean };

/** mfa を省くと false（管理権限が働かない側）に倒す */
export function toViewer(u: User, opts: { mfa?: boolean } = {}): Viewer {
  return {
    id: u.id,
    role: u.role,
    status: u.status,
    displayName: u.displayName,
    termsAccepted: u.termsAcceptedAt != null,
    mfa: opts.mfa ?? false,
  };
}

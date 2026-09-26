import { forbidden, AppError } from "./errors";
import type { Viewer } from "./viewer";

/**
 * 権限マトリクス（要件定義書 5 章）をコードにしたもの。
 * 純粋関数だけで構成し、画面・API・テストのすべてがここを通る。
 */

/** 承認済みかつ規約同意済み＝コンテンツを見られる状態 */
export function isMember(v: Viewer | null | undefined): v is Viewer {
  return !!v && v.status === "active" && v.termsAccepted;
}

/** 役割として管理者以上か（2 段階認証の有無は問わない）。画面の案内と「処分できない相手」の判定用 */
export function hasAdminRole(v: Viewer | null | undefined): boolean {
  return isMember(v) && (v.role === "admin" || v.role === "owner");
}

/**
 * 管理権限を行使できるか。管理者以上でも、2 段階認証を有効にするまでは権限が働かない（F-04）。
 * パスワードだけ漏れた管理者アカウントで、会員の情報や審査を触らせないため。
 */
export function isAdmin(v: Viewer | null | undefined): v is Viewer {
  return isMember(v) && hasAdminRole(v) && v.mfa;
}

export function isOwner(v: Viewer | null | undefined): v is Viewer {
  return isAdmin(v) && v.role === "owner";
}

export const MFA_REQUIRED_MESSAGE = "管理機能を使うには、先に 2 段階認証を設定してください。";

export function assertMember(v: Viewer | null | undefined): asserts v is Viewer {
  if (!v) throw new AppError("unauthorized", "ログインしてください。");
  if (!isMember(v)) throw forbidden("会員として承認されていないため、この操作はできません。");
}

export function assertAdmin(v: Viewer | null | undefined): asserts v is Viewer {
  assertMember(v);
  if (hasAdminRole(v) && !v.mfa) throw forbidden(MFA_REQUIRED_MESSAGE);
  if (!isAdmin(v)) throw forbidden("管理者のみが行える操作です。");
}

export function assertOwner(v: Viewer | null | undefined): asserts v is Viewer {
  assertMember(v);
  if (v.role === "owner" && !v.mfa) throw forbidden(MFA_REQUIRED_MESSAGE);
  if (!isOwner(v)) throw forbidden("オーナーのみが行える操作です。");
}

/** 会員 1 人あたりの月間招待枠。管理権限を行使できる人は無制限 */
export const DEFAULT_MONTHLY_INVITES = 3;
export function monthlyInviteQuota(v: Viewer, override: number | null): number {
  if (isAdmin(v)) return Number.POSITIVE_INFINITY;
  return override ?? DEFAULT_MONTHLY_INVITES;
}

/** 通報がこの人数に達したら自動で一時非表示 */
export const AUTO_HIDE_REPORT_THRESHOLD = 3;
/** 却下後に再申請できるまでの日数 */
export const REAPPLY_COOLDOWN_DAYS = 30;
/** 招待リンクの既定の有効期限 */
export const INVITE_TTL_DAYS = 7;
/** 審査の目標時間（超過を管理画面で強調） */
export const REVIEW_SLA_HOURS = 72;

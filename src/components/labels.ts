export const STATUS_LABEL: Record<string, string> = {
  unverified: "メール未確認",
  pending: "申請中",
  active: "会員",
  suspended: "停止中",
  rejected: "却下",
  withdrawn: "退会",
};
export const ROLE_LABEL: Record<string, string> = { member: "一般", admin: "管理者", owner: "オーナー" };
export const STATUS_BADGE: Record<string, string> = {
  unverified: "bg-canvas text-muted",
  pending: "bg-warn-soft text-warn",
  active: "bg-ok-soft text-ok",
  suspended: "bg-danger-soft text-danger",
  rejected: "bg-canvas text-muted",
  withdrawn: "bg-canvas text-muted",
};

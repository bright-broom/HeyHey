/**
 * 運営者情報（利用規約・プライバシーポリシー・問い合わせ先に出す）。
 * 本番では OPERATOR_NAME と CONTACT_EMAIL を必ず設定する（管理画面のリリース前チェックで確認できる）。
 */
export type OperatorInfo = { name: string | null; contactEmail: string | null };

export function operatorInfo(): OperatorInfo {
  const name = process.env.OPERATOR_NAME?.trim() || null;
  const email = process.env.CONTACT_EMAIL?.trim() || null;
  return { name, contactEmail: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null };
}

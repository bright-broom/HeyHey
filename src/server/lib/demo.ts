import { databaseUrl, isHttps } from "./env";

/**
 * デモアカウントの台帳。シード（scripts/seed.ts --demo）とログイン画面のデモ一覧の両方がここを読む。
 * 権限（管理者／会員）と状態（2 段階認証・規約同意・申請中・停止など）の組み合わせを、
 * 画面で確かめたい単位で 1 人ずつ用意する。
 */
export const DEMO_PASSWORD = "demo-password-123";
/** デモの管理者などの 2 段階認証の鍵（ローカル専用。認証アプリに手入力すればコードが出る） */
export const DEMO_TOTP_SECRET = "KAKOMIDEMOKAKOMIDEMOKAKOMIDEMO23";

export type DemoGroup = "admin" | "member" | "applicant" | "blocked";

export type DemoAccount = {
  email: string;
  name: string;
  group: DemoGroup;
  role: "admin" | "member";
  /** 最初の管理者（シードが作る人と同じ） */
  firstAdmin?: boolean;
  status: "active" | "pending" | "unverified" | "suspended" | "rejected";
  /** 状態の短い名前（一覧のラベル） */
  label: string;
  /** この人で入ると何を確かめられるか */
  tryThis: string;
  mfa?: boolean;
  /** 承認済みだが規約に未同意 */
  termsPending?: boolean;
  affiliation?: string;
  bio?: string;
};

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { email: "owner@example.com", name: "運営", group: "admin", role: "admin", firstAdmin: true, status: "active", mfa: true, label: "管理者（最初の 1 人）", tryThis: "すべての管理機能。管理者の任命・解任（ほかの管理者に知らされる）", affiliation: "運営" },
  { email: "admin@example.com", name: "管理 花子", group: "admin", role: "admin", status: "active", mfa: true, label: "管理者", tryThis: "入会審査（72 時間超過の申請あり）、通報対応、監査ログ", affiliation: "運営チーム", bio: "入会審査と通報対応を担当しています。" },
  { email: "admin-new@example.com", name: "新任 管理者", group: "admin", role: "admin", status: "active", label: "管理者・2 段階認証 未設定", tryThis: "管理画面に入れず、2 段階認証の設定へ案内される（設定にはチケットが必要）", affiliation: "運営チーム" },
  { email: "sato@example.com", name: "佐藤 健", group: "member", role: "member", status: "active", label: "会員", tryThis: "投稿・画像・招待リンクの発行、田中さんの「友達のみ」投稿が見える", affiliation: "株式会社サンプル", bio: "週末は山登りをしています。" },
  { email: "tanaka@example.com", name: "田中 美咲", group: "member", role: "member", status: "active", label: "会員", tryThis: "「友達のみ」の投稿者。友達・通知・リアクション", affiliation: "デザイン事務所", bio: "UI デザイナー。写真も好きです。" },
  { email: "suzuki@example.com", name: "鈴木 大輔", group: "member", role: "member", status: "active", label: "会員", tryThis: "田中さんの「友達のみ」投稿が見えない。通報された投稿の投稿者", affiliation: "フリーランス" },
  { email: "takahashi@example.com", name: "高橋 翔", group: "member", role: "member", status: "active", mfa: true, label: "会員・2 段階認証 有効", tryThis: "任意の 2 段階認証。リカバリーコードの再発行と無効化", affiliation: "株式会社サンプル" },
  { email: "ito@example.com", name: "伊藤 さくら", group: "member", role: "member", status: "active", termsPending: true, label: "承認済み・規約 未同意", tryThis: "規約に同意するまでコミュニティの中身が見えない", affiliation: "サンプル大学" },
  { email: "yamada@example.com", name: "山田 太郎", group: "applicant", role: "member", status: "pending", label: "申請中（審査待ち）", tryThis: "申請状況だけが見え、ほかのページには一切入れない", affiliation: "サンプル大学" },
  { email: "kobayashi@example.com", name: "小林 陽介", group: "applicant", role: "member", status: "unverified", label: "メール確認待ち", tryThis: "確認メールの再送。確認が済むまで審査に回らない", affiliation: "個人" },
  { email: "nakamura@example.com", name: "中村 誠", group: "blocked", role: "member", status: "suspended", label: "利用停止中", tryThis: "ログインを拒否される（停止中の表示）", affiliation: "個人" },
  { email: "watanabe@example.com", name: "渡辺 恵", group: "blocked", role: "member", status: "rejected", label: "却下", tryThis: "ログインを拒否される", affiliation: "個人" },
];

export const DEMO_GROUP_LABELS: Record<DemoGroup, string> = {
  admin: "管理者",
  member: "会員",
  applicant: "申請者",
  blocked: "入れない人",
};

export const isDemoEmail = (email: string) => DEMO_ACCOUNTS.some((a) => a.email === email.trim().toLowerCase());

/**
 * デモログイン（パスワードも 2 段階認証も省く）を使えるか。ローカルの PGlite で開発しているときだけ。
 * 認証をまるごと飛ばす機能なので、環境変数で有効にする抜け道は作らない。
 * 本番（production ビルド・Vercel・実際につなぐ PostgreSQL・https）のどれかに当てはまれば必ず無効。
 */
export function demoLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && !process.env.VERCEL && !databaseUrl() && !isHttps();
}

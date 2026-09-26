export const metadata = { title: "確認メールを送信しました" };

import { emailVerificationEnabled } from "@/server/services/auth";

export const dynamic = "force-dynamic";

export default function SentPage() {
  if (!emailVerificationEnabled()) {
    return (
      <div className="card space-y-3 p-6">
        <h1 className="h1">申請を受け付けました</h1>
        <p className="text-sm">管理者が申請内容を確認します。承認されると、登録したメールアドレスとパスワードでログインできるようになります。</p>
        <p className="text-sm text-muted">審査の状況は、ログインすると確認できます。</p>
      </div>
    );
  }
  return (
    <div className="card space-y-3 p-6">
      <h1 className="h1">確認メールを送信しました</h1>
      <p className="text-sm">入力したメールアドレスに確認用のリンクを送りました。リンクを開くと、申請が管理者に届きます。</p>
      <p className="text-sm text-muted">リンクの有効期限は 24 時間です。届かない場合は迷惑メールフォルダを確認するか、ログインして再送してください。</p>
    </div>
  );
}

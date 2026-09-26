export const metadata = { title: "確認メールを送信しました" };

export default function SentPage() {
  return (
    <div className="card space-y-3 p-6">
      <h1 className="h1">確認メールを送信しました</h1>
      <p className="text-sm">入力したメールアドレスに確認用のリンクを送りました。リンクを開くと、申請が管理者に届きます。</p>
      <p className="text-sm text-muted">リンクの有効期限は 24 時間です。届かない場合は迷惑メールフォルダを確認するか、ログインして再送してください。</p>
    </div>
  );
}

import Link from "next/link";
import { ForgotForm } from "./ForgotForm";

export const metadata = { title: "パスワードの再設定" };

export default function ForgotPage() {
  return (
    <div className="space-y-10">
      <div>
        <p className="plaque">RESET</p>
        <h1 className="h1 mt-2">パスワードの再設定</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">登録したメールアドレスに、再設定のリンクを送ります。</p>
      </div>
      <ForgotForm />
      <div className="rule" />
      <p className="text-xs leading-loose text-muted">
        2 段階認証を設定している場合は、再設定の後も認証アプリのコードが必要です。
        <br />
        <Link href="/login" className="btn-link text-xs">
          ログインに戻る
        </Link>
      </p>
    </div>
  );
}

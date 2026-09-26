import { redirect } from "next/navigation";
import { getViewer, homeFor } from "@/server/web/session";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "ログイン" };

const NOTICES: Record<string, string> = {
  inactive: "このアカウントは現在ご利用いただけません。",
  password_changed: "パスワードを変更しました。新しいパスワードでログインしてください。",
  withdrawn: "退会手続きが完了しました。ご利用ありがとうございました。",
  mfa_expired: "確認の有効期限が切れたか、試行回数の上限に達しました。もう一度ログインしてください。",
};

export default async function LoginPage(props: PageProps<"/login">) {
  const v = await getViewer();
  if (v && ["active", "pending", "unverified"].includes(v.status)) redirect(homeFor(v));
  const sp = await props.searchParams;
  const notice = typeof sp.e === "string" ? NOTICES[sp.e] : undefined;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <div className="space-y-10">
      <div>
        <p className="plaque">SIGN IN</p>
        <h1 className="h1 mt-2">ログイン</h1>
      </div>
      {notice && <p className="border-l-2 border-ink py-1 pl-3 text-sm">{notice}</p>}
      <LoginForm next={next} />
      <div className="rule" />
      <p className="text-xs leading-loose text-muted">
        はじめての方は、メンバーから届いた招待リンクを開いて申請してください。
        <br />
        招待リンクがなければ登録できません。
      </p>
    </div>
  );
}

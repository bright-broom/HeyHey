import { redirect } from "next/navigation";
import { getViewer, homeFor } from "@/server/web/session";
import { LoginForm } from "./LoginForm";

export const metadata = { title: "ログイン" };

const NOTICES: Record<string, string> = {
  inactive: "このアカウントは現在ご利用いただけません。",
  password_changed: "パスワードを変更しました。新しいパスワードでログインしてください。",
  withdrawn: "退会手続きが完了しました。ご利用ありがとうございました。",
};

export default async function LoginPage(props: PageProps<"/login">) {
  const v = await getViewer();
  if (v && ["active", "pending", "unverified"].includes(v.status)) redirect(homeFor(v));
  const sp = await props.searchParams;
  const notice = typeof sp.e === "string" ? NOTICES[sp.e] : undefined;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <div className="card space-y-5 p-6">
      <div>
        <h1 className="h1">ログイン</h1>
        <p className="mt-1 text-sm text-muted">招待を受けて承認されたメンバーだけが利用できるコミュニティです。</p>
      </div>
      {notice && <p className="rounded-lg bg-brand-soft px-3 py-2 text-sm text-brand">{notice}</p>}
      <LoginForm next={next} />
      <p className="text-xs text-muted">
        まだアカウントがない場合は、メンバーから届いた招待リンクを開いて申請してください。招待リンクがないと登録できません。
      </p>
    </div>
  );
}

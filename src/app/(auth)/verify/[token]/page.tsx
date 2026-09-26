import { VerifyForm } from "./VerifyForm";

export const metadata = { title: "メールアドレスの確認" };

export default async function VerifyPage(props: PageProps<"/verify/[token]">) {
  const { token } = await props.params;
  return (
    <div className="card space-y-4 p-6">
      <h1 className="h1">メールアドレスの確認</h1>
      <p className="text-sm text-muted">下のボタンを押すと確認が完了し、入会申請が管理者に届きます。</p>
      <VerifyForm token={token} />
    </div>
  );
}

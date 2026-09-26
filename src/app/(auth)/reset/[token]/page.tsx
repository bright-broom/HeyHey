import { ResetForm } from "./ResetForm";

export const metadata = { title: "新しいパスワード" };

/** リンクを開いただけでは何も起きない（メールのリンク検査ボットにトークンを使われないように、送信で確定する） */
export default async function ResetPage(props: PageProps<"/reset/[token]">) {
  const { token } = await props.params;
  return (
    <div className="space-y-10">
      <div>
        <p className="plaque">RESET</p>
        <h1 className="h1 mt-2">新しいパスワード</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">設定すると、すべての端末からログアウトします。</p>
      </div>
      <ResetForm token={token} />
    </div>
  );
}

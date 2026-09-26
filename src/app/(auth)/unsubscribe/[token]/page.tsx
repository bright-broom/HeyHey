import Link from "next/link";
import { parseUnsubscribeToken } from "@/server/services/email-notify";
import { UnsubscribeForm } from "./UnsubscribeForm";

export const metadata = { title: "メールの配信停止" };

/** リンクを開いただけでは止めない（メールのリンク検査ボットに止められないよう、ボタンで確定する） */
export default async function UnsubscribePage(props: PageProps<"/unsubscribe/[token]">) {
  const { token } = await props.params;
  const parsed = parseUnsubscribeToken(token);
  return (
    <div className="space-y-10">
      <div>
        <p className="plaque">EMAIL</p>
        <h1 className="h1 mt-2">メールの配信停止</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          {parsed
            ? parsed.kind === "instant"
              ? "メンション・コメント・返信・友達申請のお知らせメールを止めます。"
              : "週 1 回のまとめのメールを止めます。"
            : "このリンクは正しくありません。ログインして、設定画面から変更してください。"}
        </p>
      </div>
      {parsed && <UnsubscribeForm token={token} />}
      <div className="rule" />
      <p className="text-xs leading-loose text-muted">
        アプリ内のお知らせは、これまでどおり届きます。設定はログイン後の「設定」からいつでも戻せます。
        <br />
        <Link href="/login" className="btn-link text-xs">
          ログインする
        </Link>
      </p>
    </div>
  );
}

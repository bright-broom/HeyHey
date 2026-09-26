import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer, homeFor, readChallengeToken } from "@/server/web/session";
import { CodeForm } from "./CodeForm";

export const metadata = { title: "確認コード" };

export default async function LoginCodePage(props: PageProps<"/login/2fa">) {
  const v = await getViewer();
  if (v && ["active", "pending", "unverified"].includes(v.status)) redirect(homeFor(v));
  if (!(await readChallengeToken())) redirect("/login");
  const sp = await props.searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <div className="space-y-10">
      <div>
        <p className="plaque">VERIFY</p>
        <h1 className="h1 mt-2">確認コード</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">認証アプリに表示されている 6 桁の数字を入力してください。</p>
      </div>
      <CodeForm next={next} />
      <div className="rule" />
      <p className="text-xs leading-loose text-muted">
        スマートフォンが手元にないときは、設定のときに控えたリカバリーコードを入力してください。
        <br />
        <Link href="/login" className="btn-link text-xs">
          最初からやり直す
        </Link>
      </p>
    </div>
  );
}

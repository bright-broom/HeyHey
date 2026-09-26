import { getDb } from "@/server/db/client";
import { checkInvitation } from "@/server/services/invites";
import { RegisterForm } from "./RegisterForm";

export const metadata = { title: "入会申請" };

export default async function JoinPage(props: PageProps<"/join/[token]">) {
  const { token } = await props.params;
  const check = await checkInvitation(await getDb(), token);
  if (!check.ok) {
    return (
      <div className="card space-y-3 p-6">
        <h1 className="h1">招待リンクを確認できません</h1>
        <p className="text-sm text-muted">{check.message}</p>
        <p className="text-sm text-muted">招待してくれたメンバーに、新しいリンクの発行を依頼してください。</p>
      </div>
    );
  }
  return (
    <div className="card space-y-5 p-6">
      <div>
        <h1 className="h1">入会申請</h1>
        <p className="mt-1 text-sm text-muted">
          <strong className="text-ink">{check.inviterName}</strong> さんから招待されています。申請内容を管理者が確認し、承認されると参加できます。
        </p>
      </div>
      <RegisterForm token={token} />
    </div>
  );
}

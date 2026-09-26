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
    <div className="card space-y-10 p-6">
      <div>
        <p className="plaque">APPLICATION</p>
        <h1 className="h1 mt-2">入会申請</h1>
        <p className="mt-4 text-sm leading-loose text-muted">
          <strong className="font-medium text-ink">{check.inviterName}</strong> さんから招待されています。
          <br />
          管理者が申請を確認し、承認されると参加できます。
        </p>
      </div>
      <RegisterForm token={token} />
    </div>
  );
}

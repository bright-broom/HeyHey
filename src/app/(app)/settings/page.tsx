import { getDb } from "@/server/db/client";
import { getProfile } from "@/server/services/members";
import { requireMember } from "@/server/web/session";
import { PasswordForm, ProfileForm, WithdrawForm } from "./Forms";

export const metadata = { title: "設定" };

export default async function SettingsPage() {
  const viewer = await requireMember();
  const me = (await getProfile(await getDb(), viewer, viewer.id))!;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="h1">設定</h1>
      <section className="card space-y-3 p-5">
        <h2 className="h2">プロフィール</h2>
        <ProfileForm displayName={me.displayName} affiliation={me.affiliation} bio={me.bio} hasAvatar={!!me.avatarMediaId} />
      </section>
      <section className="card space-y-3 p-5">
        <h2 className="h2">パスワード</h2>
        <PasswordForm />
      </section>
      <section className="card space-y-3 border-danger/30 p-5">
        <h2 className="h2 text-danger">退会</h2>
        {viewer.role === "owner" ? (
          <p className="text-sm text-muted">オーナーは退会できません。先に別の会員へオーナー権限を移してください。</p>
        ) : (
          <WithdrawForm />
        )}
      </section>
    </div>
  );
}

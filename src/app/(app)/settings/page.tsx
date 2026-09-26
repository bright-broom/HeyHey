import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { getProfile } from "@/server/services/members";
import { requireMember } from "@/server/web/session";
import { PasswordForm, ProfileForm, WithdrawForm } from "./Forms";

export const metadata = { title: "設定" };

export default async function SettingsPage() {
  const viewer = await requireMember();
  const me = (await getProfile(await getDb(), viewer, viewer.id))!;
  return (
    <div className="max-w-3xl space-y-10">
      <PageTitle plaque="SETTINGS" title="設定" />
      <section className="card space-y-6 p-6 sm:p-8">
        <h2 className="h2">プロフィール</h2>
        <ProfileForm displayName={me.displayName} affiliation={me.affiliation} bio={me.bio} hasAvatar={!!me.avatarMediaId} />
      </section>
      <section className="card space-y-6 p-6 sm:p-8">
        <h2 className="h2">パスワード</h2>
        <PasswordForm />
      </section>
      <section className="space-y-6 border border-danger/40 p-6 sm:p-8">
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

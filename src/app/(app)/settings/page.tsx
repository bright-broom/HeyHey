import Link from "next/link";
import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { relationAction } from "@/app/actions/social";
import { Avatar } from "@/components/Avatar";
import { listBlocksAndMutes } from "@/server/services/blocks";
import { getProfile } from "@/server/services/members";
import { requireMember } from "@/server/web/session";
import { PasswordForm, ProfileForm, WithdrawForm } from "./Forms";

export const metadata = { title: "設定" };

export default async function SettingsPage() {
  const viewer = await requireMember();
  const db = await getDb();
  const [me, relations] = await Promise.all([getProfile(db, viewer, viewer.id).then((p) => p!), listBlocksAndMutes(db, viewer)]);
  return (
    <div className="max-w-3xl space-y-10">
      <PageTitle plaque="SETTINGS" title="設定" />
      <section className="card space-y-6 p-6 sm:p-8">
        <h2 className="h2">プロフィール</h2>
        <ProfileForm displayName={me.displayName} affiliation={me.affiliation} bio={me.bio} hasAvatar={!!me.avatarMediaId} />
      </section>
      <section className="card flex flex-wrap items-center justify-between gap-4 p-6 sm:p-8">
        <div>
          <h2 className="h2">2 段階認証</h2>
          <p className="mt-2 text-sm text-muted">{viewer.mfa ? "有効" : viewer.role === "member" ? "未設定（任意）" : "未設定（管理者は必須）"}</p>
        </div>
        <Link href="/settings/security" className="btn-ghost">
          {viewer.mfa ? "管理する" : "設定する"}
        </Link>
      </section>
      <section className="card space-y-6 p-6 sm:p-8">
        <h2 className="h2">パスワード</h2>
        <PasswordForm />
      </section>
      <section className="card space-y-6 p-6 sm:p-8">
        <h2 className="h2">ブロック・ミュート中の人</h2>
        {relations.blocked.length === 0 && relations.muted.length === 0 ? (
          <p className="text-sm text-muted">いません。メンバーのプロフィールから設定できます。</p>
        ) : (
          <ul className="divide-y divide-line border-y border-line">
            {[...relations.blocked.map((p) => ({ ...p, op: "unblock", label: "ブロック中", action: "解除" })), ...relations.muted.map((p) => ({ ...p, op: "unmute", label: "ミュート中", action: "解除" }))].map((p) => (
              <li key={`${p.op}-${p.id}`} className="flex items-center gap-3 py-3">
                <Avatar name={p.displayName} mediaId={p.avatarMediaId} size={28} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {p.displayName}
                  <span className="ml-2 text-xs text-muted">{p.label}</span>
                </span>
                <form action={relationAction}>
                  <input type="hidden" name="userId" value={p.id} />
                  <input type="hidden" name="op" value={p.op} />
                  <button className="btn-ghost px-3 py-1.5 text-xs" aria-label={`${p.displayName}の${p.label}を解除`}>{p.action}</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card flex flex-wrap items-center justify-between gap-4 p-6 sm:p-8">
        <div className="max-w-md">
          <h2 className="h2">データのダウンロード</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            登録情報・投稿・コメント・友達・招待などを JSON ファイルで受け取れます（1 日 5 回まで）。書き出したことは記録されます。
          </p>
        </div>
        <form method="post" action="/api/me/export">
          <button type="submit" className="btn-ghost">ダウンロード</button>
        </form>
      </section>
      <section className="space-y-6 border border-danger/40 p-6 sm:p-8">
        <h2 className="h2 text-danger">退会</h2>
        {viewer.role === "owner" ? (
          <p className="text-sm text-muted">
            オーナーは退会できません。先に、2 段階認証を設定済みの管理者へオーナー権限を移してください（管理画面の「会員管理」から、その管理者の画面で行えます）。
          </p>
        ) : (
          <WithdrawForm />
        )}
      </section>
    </div>
  );
}

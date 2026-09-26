"use client";

import { useActionState } from "react";
import { changePasswordAction } from "@/app/actions/auth";
import { updateProfileAction, withdrawAction } from "@/app/actions/social";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function ProfileForm({ displayName, affiliation, bio, hasAvatar }: { displayName: string; affiliation: string; bio: string; hasAvatar: boolean }) {
  const [state, action] = useActionState(updateProfileAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="displayName" className="label">表示名</label>
        <input id="displayName" name="displayName" maxLength={40} required defaultValue={displayName} className="input" />
      </div>
      <div>
        <label htmlFor="affiliation" className="label">所属</label>
        <input id="affiliation" name="affiliation" maxLength={120} defaultValue={affiliation} className="input" />
      </div>
      <div>
        <label htmlFor="bio" className="label">自己紹介</label>
        <textarea id="bio" name="bio" rows={4} maxLength={1000} defaultValue={bio} className="input" />
      </div>
      <div>
        <label htmlFor="avatar" className="label">プロフィール写真</label>
        <input id="avatar" name="avatar" type="file" accept="image/jpeg,image/png,image/webp" className="text-sm" />
        {hasAvatar && (
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input type="checkbox" name="removeAvatar" /> 現在の写真を削除する
          </label>
        )}
        <p className="hint">位置情報などのメタデータは取り除いて保存されます。</p>
      </div>
      <FormMessage state={state} />
      <SubmitButton>保存する</SubmitButton>
    </form>
  );
}

export function PasswordForm() {
  const [state, action] = useActionState(changePasswordAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="current" className="label">現在のパスワード</label>
        <input id="current" name="current" type="password" autoComplete="current-password" required className="input" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="next" className="label">新しいパスワード</label>
          <input id="next" name="next" type="password" autoComplete="new-password" minLength={10} required className="input" />
        </div>
        <div>
          <label htmlFor="nextConfirm" className="label">新しいパスワード（確認）</label>
          <input id="nextConfirm" name="nextConfirm" type="password" autoComplete="new-password" minLength={10} required className="input" />
        </div>
      </div>
      <FormMessage state={state} />
      <SubmitButton>変更する</SubmitButton>
      <p className="hint">変更すると、すべての端末からログアウトされます。</p>
    </form>
  );
}

export function WithdrawForm() {
  const [state, action] = useActionState(withdrawAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <fieldset className="space-y-2">
        <legend className="label">これまでの投稿とコメント</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="mode" value="anonymize" defaultChecked className="mt-1" />
          <span>匿名化して残す（「退会したメンバー」として表示）</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="mode" value="delete" className="mt-1" />
          <span>すべて削除する</span>
        </label>
      </fieldset>
      <div>
        <label htmlFor="wpassword" className="label">パスワード</label>
        <input id="wpassword" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      <div>
        <label htmlFor="confirm" className="label">確認のため「退会する」と入力</label>
        <input id="confirm" name="confirm" required className="input" />
      </div>
      <FormMessage state={state} />
      <SubmitButton className="btn-danger">退会する</SubmitButton>
    </form>
  );
}

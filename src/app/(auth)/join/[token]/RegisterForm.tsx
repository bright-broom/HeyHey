"use client";

import Link from "next/link";
import { useActionState } from "react";
import { registerAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function RegisterForm({ token }: { token: string }) {
  const [state, action] = useActionState(registerAction, undefined);
  const f = state?.fields ?? {};
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <fieldset className="space-y-3">
        <legend className="h2 mb-2">アカウント</legend>
        <div>
          <label htmlFor="email" className="label">メールアドレス</label>
          <input id="email" name="email" type="email" autoComplete="email" required defaultValue={f.email} className="input" />
          <p className="hint">確認メールが届きます。</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="password" className="label">パスワード</label>
            <input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required className="input" />
            <p className="hint">10 文字以上</p>
          </div>
          <div>
            <label htmlFor="passwordConfirm" className="label">パスワード（確認）</label>
            <input id="passwordConfirm" name="passwordConfirm" type="password" autoComplete="new-password" minLength={10} required className="input" />
          </div>
        </div>
        <div>
          <label htmlFor="displayName" className="label">表示名</label>
          <input id="displayName" name="displayName" maxLength={40} required defaultValue={f.displayName} className="input" />
          <p className="hint">コミュニティ内で表示される名前です。</p>
        </div>
      </fieldset>

      <fieldset className="space-y-3 border-t border-line pt-4">
        <legend className="h2 mb-2">入会申請（管理者だけが見ます）</legend>
        <div>
          <label htmlFor="fullName" className="label">氏名</label>
          <input id="fullName" name="fullName" maxLength={80} required defaultValue={f.fullName} className="input" />
        </div>
        <div>
          <label htmlFor="affiliation" className="label">所属（任意）</label>
          <input id="affiliation" name="affiliation" maxLength={120} defaultValue={f.affiliation} className="input" />
        </div>
        <div>
          <label htmlFor="relationship" className="label">招待者との関係</label>
          <input id="relationship" name="relationship" maxLength={200} required placeholder="例：前職の同僚、大学の同期" defaultValue={f.relationship} className="input" />
        </div>
        <div>
          <label htmlFor="introduction" className="label">自己紹介</label>
          <textarea id="introduction" name="introduction" rows={4} maxLength={1000} required defaultValue={f.introduction} className="input" />
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="agree" required className="mt-1" />
        <span>
          <Link href="/terms" target="_blank" className="btn-link">利用規約</Link> と{" "}
          <Link href="/privacy" target="_blank" className="btn-link">プライバシーポリシー</Link> に同意します
        </span>
      </label>
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full" pendingText="送信中…">申請する</SubmitButton>
    </form>
  );
}

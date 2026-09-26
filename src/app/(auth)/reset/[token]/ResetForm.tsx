"use client";

import { useActionState } from "react";
import { resetPasswordAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function ResetForm({ token }: { token: string }) {
  const [state, action] = useActionState(resetPasswordAction, undefined);
  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="next" className="label">新しいパスワード</label>
        <input id="next" name="next" type="password" autoComplete="new-password" minLength={10} required className="input" />
        <p className="hint">10 文字以上</p>
      </div>
      <div>
        <label htmlFor="nextConfirm" className="label">新しいパスワード（確認）</label>
        <input id="nextConfirm" name="nextConfirm" type="password" autoComplete="new-password" minLength={10} required className="input" />
      </div>
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full" pendingText="設定中…">パスワードを設定する</SubmitButton>
    </form>
  );
}

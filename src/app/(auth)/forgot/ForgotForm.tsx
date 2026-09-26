"use client";

import { useActionState } from "react";
import { forgotPasswordAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function ForgotForm() {
  const [state, action] = useActionState(forgotPasswordAction, undefined);
  if (state?.ok) return <FormMessage state={state} />;
  return (
    <form action={action} className="space-y-6">
      <div>
        <label htmlFor="email" className="label">メールアドレス</label>
        <input id="email" name="email" type="email" autoComplete="email" required className="input" />
      </div>
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full" pendingText="送信中…">再設定のメールを送る</SubmitButton>
    </form>
  );
}

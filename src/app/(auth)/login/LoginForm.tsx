"use client";

import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(loginAction, undefined);
  return (
    <form action={action} className="space-y-4">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <label htmlFor="email" className="label">メールアドレス</label>
        <input id="email" name="email" type="email" autoComplete="email" required defaultValue={state?.fields?.email} className="input" />
      </div>
      <div>
        <label htmlFor="password" className="label">パスワード</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required className="input" />
      </div>
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full" pendingText="確認中…">ログイン</SubmitButton>
    </form>
  );
}

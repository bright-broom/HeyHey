"use client";

import { useActionState } from "react";
import { resendVerificationAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function ResendForm({ email }: { email: string }) {
  const [state, action] = useActionState(resendVerificationAction, undefined);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="email" value={email} />
      <FormMessage state={state} />
      <SubmitButton className="btn-ghost">確認メールを再送する</SubmitButton>
    </form>
  );
}

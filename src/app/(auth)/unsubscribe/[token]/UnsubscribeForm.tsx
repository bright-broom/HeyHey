"use client";

import { useActionState } from "react";
import { unsubscribeAction } from "@/app/actions/social";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function UnsubscribeForm({ token }: { token: string }) {
  const [state, action] = useActionState(unsubscribeAction, undefined);
  if (state?.ok) return <FormMessage state={state} />;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full">配信を止める</SubmitButton>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { loginCodeAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function CodeForm({ next }: { next?: string }) {
  const [state, action] = useActionState(loginCodeAction, undefined);
  return (
    <form action={action} className="space-y-6">
      {next && <input type="hidden" name="next" value={next} />}
      <div>
        <label htmlFor="code" className="label">確認コード</label>
        {/* リカバリーコード（英数字）も受けるので inputMode は text のまま */}
        <input id="code" name="code" autoComplete="one-time-code" autoFocus required maxLength={20} className="input text-center text-lg tabular-nums tracking-[0.3em]" />
      </div>
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full" pendingText="確認中…">確認する</SubmitButton>
    </form>
  );
}

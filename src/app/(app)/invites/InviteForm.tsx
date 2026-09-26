"use client";

import { useActionState, useState } from "react";
import { createInviteAction } from "@/app/actions/social";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function InviteForm({ admin, disabled }: { admin: boolean; disabled: boolean }) {
  const [state, action] = useActionState(createInviteAction, undefined);
  const [copied, setCopied] = useState(false);
  const url = state?.ok;
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-3">
        <div>
          <label htmlFor="note" className="label">メモ（任意・自分だけに表示）</label>
          <input id="note" name="note" maxLength={100} placeholder="例：佐藤さん用" className="input" />
        </div>
        {admin && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="maxUses" className="label">使用回数</label>
              <input id="maxUses" name="maxUses" type="number" min={1} max={50} defaultValue={1} className="input" />
            </div>
            <div>
              <label htmlFor="ttlDays" className="label">有効日数</label>
              <input id="ttlDays" name="ttlDays" type="number" min={1} max={30} defaultValue={7} className="input" />
            </div>
          </div>
        )}
        {state?.error && <FormMessage state={state} />}
        <SubmitButton className="btn-primary" disabled={disabled}>招待リンクを発行</SubmitButton>
      </form>
      {url && (
        <div className="space-y-2 rounded-lg border border-ok/30 bg-ok-soft p-3">
          <p className="text-sm font-semibold text-ok">招待リンクを発行しました。この画面を閉じると再表示できません。</p>
          <div className="flex gap-2">
            <input readOnly value={url} className="input font-mono text-xs" aria-label="招待リンク" data-testid="invite-url" onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className="btn-ghost shrink-0"
              onClick={async () => {
                await navigator.clipboard.writeText(url);
                setCopied(true);
              }}
            >
              {copied ? "コピー済み" : "コピー"}
            </button>
          </div>
          <p className="hint">相手に直接送ってください。SNS など不特定多数が見られる場所には貼らないでください。</p>
        </div>
      )}
    </div>
  );
}

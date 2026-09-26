"use client";

import { useActionState, useState } from "react";
import { decideApplicationAction } from "@/app/actions/admin";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

const REASONS = [
  ["unknown_relation", "招待者との関係が確認できない"],
  ["incomplete", "申請内容が不十分"],
  ["policy", "参加条件に合わない"],
  ["other", "その他"],
] as const;

export function DecisionForm({ applicationId }: { applicationId: string }) {
  const [state, action] = useActionState(decideApplicationAction, undefined);
  const [mode, setMode] = useState<"approve" | "reject" | "hold">("approve");
  if (state?.ok) return <FormMessage state={state} />;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="kind" value={mode} />
      <div role="radiogroup" aria-label="判断" className="grid w-full grid-cols-3 border border-line-strong">
        {(
          [
            ["approve", "承認"],
            ["reject", "却下"],
            ["hold", "保留"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={mode === k}
            onClick={() => setMode(k)}
            className={`px-4 py-2 text-xs tracking-[0.08em] transition-colors duration-200 ${mode === k ? "bg-ink text-light" : "text-muted hover:text-ink"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {mode === "reject" && (
        <select name="reasonKey" required defaultValue="" className="input text-sm" aria-label="却下理由">
          <option value="" disabled>却下理由を選ぶ（本人にメールで伝わります）</option>
          {REASONS.map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
      )}
      {mode !== "approve" && <textarea name="note" rows={2} maxLength={500} placeholder={mode === "hold" ? "保留の理由（管理者間のメモ）" : "補足（任意・本人に伝わります）"} className="input text-sm" />}
      <FormMessage state={state} />
      <SubmitButton className={mode === "reject" ? "btn-danger w-full" : "btn-primary w-full"}>
        {mode === "approve" ? "承認する" : mode === "reject" ? "却下する" : "保留にする"}
      </SubmitButton>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";
import { resolveReportAction } from "@/app/actions/admin";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

export function ResolveForm({ targetType, targetId, canSuspend }: { targetType: string; targetId: string; canSuspend: boolean }) {
  const [state, action] = useActionState(resolveReportAction, undefined);
  const [resolution, setResolution] = useState("dismissed");
  const options = [
    ["dismissed", "問題なし（自動非表示を解除）"],
    ...(targetType !== "user" ? [["hidden", "非表示にする"]] : []),
    ["warned", "投稿者に警告する"],
    ...(canSuspend ? [["suspended", "投稿者を利用停止にする"]] : []),
  ];
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <fieldset className="space-y-1.5">
        <legend className="label">対応</legend>
        {options.map(([v, l]) => (
          <label key={v} className="flex items-center gap-2 text-sm">
            <input type="radio" name="resolution" value={v} checked={resolution === v} onChange={() => setResolution(v!)} />
            {l}
          </label>
        ))}
      </fieldset>
      <textarea
        name="note"
        rows={3}
        maxLength={500}
        required={resolution === "suspended"}
        placeholder={resolution === "suspended" ? "停止理由（必須）" : "判断の理由・投稿者へのメッセージ（任意）"}
        className="input text-sm"
      />
      <FormMessage state={state} />
      <SubmitButton className={resolution === "suspended" ? "btn-danger w-full" : "btn-primary w-full"}>この内容で処理する</SubmitButton>
      <p className="hint">通報者全員に処理結果が通知されます（通報者名は投稿者に伝わりません）。</p>
    </form>
  );
}

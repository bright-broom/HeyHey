"use client";

import { useActionState } from "react";
import { reportAction } from "@/app/actions/content";
import { FormMessage } from "./FormMessage";
import { SubmitButton } from "./SubmitButton";

const REASONS = [
  ["spam", "スパム・宣伝"],
  ["harassment", "嫌がらせ・攻撃的な内容"],
  ["inappropriate", "不適切な内容"],
  ["privacy", "個人情報・プライバシーの侵害"],
  ["other", "その他"],
] as const;

export function ReportForm({ targetType, targetId }: { targetType: "post" | "comment" | "user"; targetId: string }) {
  const [state, action] = useActionState(reportAction, undefined);
  if (state?.ok) return <FormMessage state={state} />;
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="targetType" value={targetType} />
      <input type="hidden" name="targetId" value={targetId} />
      <select name="reason" required defaultValue="" className="input py-1.5 text-sm" aria-label="通報の理由">
        <option value="" disabled>
          理由を選ぶ
        </option>
        {REASONS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <textarea name="detail" rows={2} maxLength={1000} placeholder="補足（任意）" className="input text-sm" />
      <FormMessage state={state} />
      <SubmitButton className="btn-danger w-full py-1.5">通報する</SubmitButton>
      <p className="hint">通報者の名前は相手に伝わりません。</p>
    </form>
  );
}

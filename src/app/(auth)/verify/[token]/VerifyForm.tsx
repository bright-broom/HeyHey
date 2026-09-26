"use client";

import Link from "next/link";
import { useActionState } from "react";
import { verifyAction } from "@/app/actions/auth";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

/** メールのリンクを開いただけでは確認しない（メールのリンク検査ボットによる誤確認を防ぐ） */
export function VerifyForm({ token }: { token: string }) {
  const [state, action] = useActionState(verifyAction, undefined);
  if (state?.ok)
    return (
      <div className="space-y-3">
        <FormMessage state={state} />
        <Link href="/status" className="btn-ghost">申請状況を見る</Link>
      </div>
    );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <FormMessage state={state} />
      <SubmitButton className="btn-primary w-full">メールアドレスを確認する</SubmitButton>
    </form>
  );
}

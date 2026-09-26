"use client";

import Link from "next/link";
import { useActionState } from "react";
import { updatePostAction } from "@/app/actions/content";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";
import { VisibilityToggle } from "@/components/VisibilityToggle";

export function EditForm({ id, body, visibility }: { id: string; body: string; visibility: string }) {
  const [state, action] = useActionState(updatePostAction, undefined);
  return (
    <form action={action} className="card space-y-5 p-6">
      <input type="hidden" name="postId" value={id} />
      <textarea name="body" rows={6} maxLength={5000} defaultValue={body} className="input" aria-label="本文" />
      <VisibilityToggle defaultValue={visibility} />
      <FormMessage state={state} />
      <div className="flex gap-2">
        <SubmitButton>保存する</SubmitButton>
        <Link href={`/posts/${id}`} className="btn-ghost">キャンセル</Link>
      </div>
      <p className="hint">画像の差し替えはできません。変えたい場合は投稿し直してください。</p>
    </form>
  );
}

"use client";

import { useActionState, useEffect, useRef } from "react";
import { commentAction } from "@/app/actions/content";
import { SubmitButton } from "./SubmitButton";

export function CommentForm({ postId, parentId, placeholder = "コメントを書く…" }: { postId: string; parentId?: string; placeholder?: string }) {
  const [state, action] = useActionState(commentAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-1">
      <input type="hidden" name="postId" value={postId} />
      {parentId && <input type="hidden" name="parentId" value={parentId} />}
      <div className="flex gap-2">
        <input name="body" maxLength={2000} required placeholder={placeholder} defaultValue={state?.fields?.body} className="input py-1.5 text-sm" aria-label={placeholder} />
        <SubmitButton className="btn-ghost shrink-0 py-1.5" pendingText="…">
          送信
        </SubmitButton>
      </div>
      {state?.error && <p role="alert" className="text-xs text-danger">{state.error}</p>}
    </form>
  );
}

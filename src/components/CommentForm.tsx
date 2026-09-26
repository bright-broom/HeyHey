"use client";

import { useActionState, useEffect, useRef } from "react";
import { commentAction } from "@/app/actions/content";
import { SubmitButton } from "./SubmitButton";

/** 一本の線の上に書く。枠は持たず、書いているときだけ線が墨になる */
export function CommentForm({ postId, parentId, placeholder = "コメントを書く" }: { postId: string; parentId?: string; placeholder?: string }) {
  const [state, action] = useActionState(commentAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action}>
      <input type="hidden" name="postId" value={postId} />
      {parentId && <input type="hidden" name="parentId" value={parentId} />}
      <div className="flex items-center gap-3 border border-transparent bg-light/70 px-4 transition-colors duration-200 focus-within:border-ink focus-within:bg-light">
        <input
          name="body"
          maxLength={2000}
          required
          placeholder={placeholder}
          defaultValue={state?.fields?.body}
          className="min-w-0 flex-1 bg-transparent py-2.5 text-sm outline-none placeholder:text-muted/80"
          aria-label={placeholder}
        />
        <SubmitButton className="shrink-0 py-2 text-xs tracking-[0.12em] text-muted transition-colors hover:text-ink disabled:opacity-40" pendingText="…">
          送信
        </SubmitButton>
      </div>
      {state?.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}

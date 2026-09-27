"use client";

import { useActionState, useEffect, useRef } from "react";
import { sendMessageAction } from "@/app/actions/messages";
import { SubmitButton } from "@/components/SubmitButton";

/** 送信欄。Enter は改行、⌘/Ctrl + Enter で送る */
export function MessageForm({ to }: { to: string }) {
  const [state, action] = useActionState(sendMessageAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state && !state.error) ref.current?.reset();
    window.scrollTo({ top: document.body.scrollHeight });
  }, [state]);
  return (
    <form ref={ref} action={action} className="border border-line bg-light focus-within:border-ink">
      <input type="hidden" name="to" value={to} />
      <textarea
        name="body"
        rows={3}
        maxLength={2000}
        required
        defaultValue={state?.fields?.body}
        aria-label="メッセージ"
        placeholder="メッセージを書く（⌘ / Ctrl + Enter で送信）"
        className="block w-full resize-y border-0 bg-transparent px-4 pt-4 text-[15px] leading-relaxed outline-none placeholder:text-muted/80"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            ref.current?.requestSubmit();
          }
        }}
      />
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <p role="alert" className="text-xs text-danger">
          {state?.error}
        </p>
        <SubmitButton className="btn-primary" pendingText="送信中…">
          送る
        </SubmitButton>
      </div>
    </form>
  );
}

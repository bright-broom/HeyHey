"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createPostAction } from "@/app/actions/content";
import { FormMessage } from "./FormMessage";
import { SubmitButton } from "./SubmitButton";

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024;

export function Composer({ name }: { name: string }) {
  const [state, action] = useActionState(createPostAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  // React 19 は送信後にフォームを自動リセットする（選んだ画像も外れる）ので、プレビューも合わせて消す
  useEffect(() => {
    if (state) setPreviews([]);
    if (state?.ok) formRef.current?.reset();
  }, [state]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(e.target.files ?? []);
    setFileError(null);
    if (list.length > MAX_FILES) {
      setFileError(`画像は ${MAX_FILES} 枚までです。`);
      e.target.value = "";
      setPreviews([]);
      return;
    }
    if (list.some((f) => f.size > MAX_BYTES)) {
      setFileError("画像は 1 枚 8MB までです。");
      e.target.value = "";
      setPreviews([]);
      return;
    }
    setPreviews(list.map((f) => URL.createObjectURL(f)));
  }

  return (
    <form ref={formRef} action={action} className="card space-y-3 p-4" aria-label="投稿する">
      <textarea
        name="body"
        rows={3}
        maxLength={5000}
        defaultValue={state?.fields?.body}
        placeholder={`${name} さん、いまどうしていますか？`}
        className="input resize-y"
        aria-label="本文"
      />
      {previews.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {previews.map((u) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={u} src={u} alt="" className="aspect-square w-full rounded-lg object-cover" />
          ))}
        </div>
      )}
      <FormMessage state={fileError ? { error: fileError } : state?.error ? state : undefined} />
      <div className="flex flex-wrap items-center gap-2">
        <label className="btn-ghost cursor-pointer">
          画像を追加
          <input ref={fileRef} type="file" name="images" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="sr-only" onChange={onFiles} />
        </label>
        <select name="visibility" defaultValue="members" className="input w-auto py-2 text-sm" aria-label="公開範囲">
          <option value="members">全会員に公開</option>
          <option value="friends">友達のみ</option>
        </select>
        <SubmitButton className="btn-primary ml-auto" pendingText="投稿中…">
          投稿する
        </SubmitButton>
      </div>
      <p className="hint">画像は位置情報などのメタデータを取り除いてから保存されます。</p>
    </form>
  );
}

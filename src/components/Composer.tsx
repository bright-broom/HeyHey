"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { createPostAction } from "@/app/actions/content";
import { FormMessage } from "./FormMessage";
import { MentionField } from "./MentionField";
import { SubmitButton } from "./SubmitButton";
import { VisibilityToggle } from "./VisibilityToggle";

const MAX_FILES = 4;
const MAX_BYTES = 8 * 1024 * 1024;

/** 光の当たった一枚の面。書く場所だけを置き、道具は下の一列にまとめる */
export function Composer({ name }: { name: string }) {
  const [state, action] = useActionState(createPostAction, undefined);
  const formRef = useRef<HTMLFormElement>(null);
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
    const reject = (msg: string) => {
      setFileError(msg);
      e.target.value = "";
      setPreviews([]);
    };
    if (list.length > MAX_FILES) return reject(`画像は ${MAX_FILES} 枚までです。`);
    if (list.some((f) => f.size > MAX_BYTES)) return reject("画像は 1 枚 8MB までです。");
    setPreviews(list.map((f) => URL.createObjectURL(f)));
  }

  return (
    <form ref={formRef} action={action} className="border border-line bg-light transition-colors duration-200 focus-within:border-ink" aria-label="投稿する">
      <MentionField
        multiline
        name="body"
        rows={3}
        maxLength={5000}
        defaultValue={state?.fields?.body}
        placeholder={`${name} さん、いま何を考えていますか。（@ でメンション、# でタグ）`}
        className="block w-full resize-y border-0 bg-transparent px-4 pb-4 pt-5 text-[15px] leading-[1.9] outline-none placeholder:text-muted/80 sm:px-6 sm:pt-6"
        aria-label="本文"
      />
      {previews.length > 0 && (
        <div className="px-4 pb-4 sm:px-6">
          <div className="grid grid-cols-4 gap-0.5">
            {previews.map((u) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={u} src={u} alt="" className="aspect-square w-full object-cover" />
            ))}
          </div>
          {/* 画像を選んだときだけ、必要な安心材料を添える */}
          <p className="hint">位置情報などのメタデータは取り除いてから保存されます。</p>
        </div>
      )}
      {(fileError || state?.error) && (
        <div className="px-4 pb-4 sm:px-6">
          <FormMessage state={fileError ? { error: fileError } : state} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 sm:px-6">
        <label className="cursor-pointer text-xs tracking-[0.08em] text-muted transition-colors hover:text-ink">
          ＋ 画像{previews.length ? `（${previews.length}）` : ""}
          <input type="file" name="images" accept="image/jpeg,image/png,image/webp,image/gif" multiple className="sr-only" onChange={onFiles} />
        </label>
        <div className="ml-auto flex items-center gap-3">
          <VisibilityToggle />
          <SubmitButton className="btn-primary" pendingText="投稿中…">
            投稿する
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

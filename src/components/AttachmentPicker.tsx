"use client";

import { useEffect, useState } from "react";

export type UploadMode = "blob" | "disk";
type Item = { id: string; name: string; size: number; key?: string; progress: number; error?: string };

const MB = 1024 * 1024;
const TYPES: Record<string, { label: string; max: number; mime: string }> = {
  mp4: { label: "動画", max: 50 * MB, mime: "video/mp4" },
  mov: { label: "動画", max: 50 * MB, mime: "video/quicktime" },
  pdf: { label: "PDF", max: 20 * MB, mime: "application/pdf" },
  docx: { label: "Word", max: 20 * MB, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xlsx: { label: "Excel", max: 20 * MB, mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  pptx: { label: "PowerPoint", max: 20 * MB, mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
};
export const MAX_ATTACHMENTS = 2;
const ACCEPT = Object.keys(TYPES).map((e) => `.${e}`).join(",");

async function uploadOne(file: File, ext: string, viewerId: string, mode: UploadMode, onProgress: (p: number) => void): Promise<string> {
  if (mode === "disk") {
    const res = await fetch(`/api/uploads/local?ext=${ext}`, { method: "PUT", body: file });
    const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
    if (!res.ok || !json.key) throw new Error(json.error ?? "アップロードできませんでした。");
    onProgress(100);
    return json.key;
  }
  const { upload } = await import("@vercel/blob/client");
  const key = `staging/${viewerId}/${crypto.randomUUID()}.${ext}`;
  await upload(`media/${key}`, file, {
    access: "private",
    handleUploadUrl: "/api/uploads",
    contentType: TYPES[ext]!.mime,
    multipart: file.size > 8 * MB,
    onUploadProgress: (e) => onProgress(Math.round(e.percentage)),
  });
  return key;
}

/**
 * 動画・ファイルの添付（F-13）。選んだらすぐ一時置き場に上げ、上がったものの一覧を隠し欄で送る。
 * 上げている間は onBusy(true) で投稿ボタンを止める。
 */
export function AttachmentPicker({ viewerId, mode, resetKey, onBusy }: { viewerId: string; mode: UploadMode; resetKey: unknown; onBusy: (busy: boolean) => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const busy = items.some((i) => !i.key && !i.error);

  useEffect(() => setItems([]), [resetKey]);
  useEffect(() => onBusy(busy), [busy, onBusy]);

  const patch = (id: string, p: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...p } : i)));

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    const room = MAX_ATTACHMENTS - items.filter((i) => !i.error).length;
    for (const [n, file] of picked.entries()) {
      const id = crypto.randomUUID();
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const type = TYPES[ext];
      const base: Item = { id, name: file.name, size: file.size, progress: 0 };
      const error =
        n >= room
          ? `動画・ファイルは ${MAX_ATTACHMENTS} 件までです。`
          : !type
            ? "この種類は添付できません（MP4・MOV・PDF・Word・Excel・PowerPoint）。"
            : file.size > type.max
              ? `${type.label}は ${type.max / MB}MB までです。`
              : undefined;
      setItems((list) => [...list, { ...base, error }]);
      if (error) continue;
      uploadOne(file, ext, viewerId, mode, (progress) => patch(id, { progress }))
        .then((key) => patch(id, { key, progress: 100 }))
        .catch((err: unknown) => patch(id, { error: err instanceof Error && /[ぁ-んァ-ン一-龥]/.test(err.message) ? err.message : "アップロードできませんでした。" }));
    }
  }

  const done = items.filter((i) => i.key).map((i) => ({ key: i.key!, name: i.name }));
  return (
    <>
      <input type="hidden" name="attachments" value={JSON.stringify(done)} />
      <label className="cursor-pointer text-xs tracking-[0.08em] text-muted transition-colors hover:text-ink">
        ＋ 動画・ファイル{done.length ? `（${done.length}）` : ""}
        <input type="file" accept={ACCEPT} multiple className="sr-only" onChange={onPick} aria-label="動画・ファイルを添付" />
      </label>
      {items.length > 0 && (
        <ul className="order-last w-full space-y-1 text-xs" aria-label="添付" aria-live="polite">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              <span className={`shrink-0 tabular-nums ${i.error ? "text-danger" : "text-muted"}`}>
                {i.error ?? (i.key ? `${(i.size / MB).toFixed(1)}MB` : `送信中 ${i.progress}%`)}
              </span>
              <button type="button" className="shrink-0 text-muted hover:text-ink" onClick={() => setItems((list) => list.filter((x) => x.id !== i.id))} aria-label={`${i.name} を外す`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

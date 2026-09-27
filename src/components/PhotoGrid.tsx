"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Photo = { id: string; width?: number; height?: number };

const src = (id: string) => `/api/media/${id}`;

/**
 * 写真の一覧と、ページの上に重ねて開く拡大表示（別のタブには移らない）。
 *
 * - 標準の <dialog>（モーダル）を使う：Esc で閉じる、フォーカスは中に閉じ込め、閉じたら元の写真に戻る
 * - 写真の外（暗い部分）をクリックすると閉じて、元の一覧がそのまま見える（スクロール位置も変わらない）
 * - 複数枚なら ← → キー、左右のボタン、スワイプで切り替える
 * - ⌘ / Ctrl / Shift を押しながらのクリックや中クリックは、これまでどおり別のタブで開ける
 *   （JavaScript が動く前も、リンクとして別のタブで開く）
 */
export function PhotoGrid({ photos, className, thumbClassName }: { photos: Photo[]; className?: string; thumbClassName?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState<number | null>(null);
  const touchX = useRef<number | null>(null);
  const count = photos.length;

  const show = useCallback((i: number) => {
    setIndex(i);
    const d = dialog.current;
    if (d && !d.open) {
      d.showModal();
      // モーダルの間は、後ろの一覧をスクロールさせない（閉じたときに位置がずれないように）
      document.documentElement.style.overflow = "hidden";
    }
  }, []);
  const close = useCallback(() => dialog.current?.close(), []);
  const step = useCallback((delta: number) => setIndex((i) => (i === null ? i : (i + delta + count) % count)), [count]);

  // 前後の写真を先に読み込んでおく（切り替えをすぐにするため）
  useEffect(() => {
    if (index === null || count < 2) return;
    for (const d of [-1, 1]) new Image().src = src(photos[(index + d + count) % count]!.id);
  }, [index, count, photos]);

  // 開いたまま画面を離れても、スクロールの固定を残さない
  useEffect(() => () => void (document.documentElement.style.overflow = ""), []);

  function onThumbClick(e: React.MouseEvent, i: number) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    show(i);
  }

  const current = index === null ? null : photos[index]!;
  return (
    <>
      <div className={className}>
        {photos.map((p, i) => (
          <a
            key={p.id}
            href={src(p.id)}
            target="_blank"
            rel="noopener"
            onClick={(e) => onThumbClick(e, i)}
            aria-label={count > 1 ? `写真 ${i + 1} / ${count} を拡大` : "写真を拡大"}
            aria-haspopup="dialog"
            className="block cursor-zoom-in bg-concrete"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src(p.id)} alt="" width={p.width || undefined} height={p.height || undefined} loading="lazy" className={thumbClassName} />
          </a>
        ))}
      </div>

      <dialog
        ref={dialog}
        aria-label={current ? (count > 1 ? `写真 ${index! + 1} / ${count}` : "写真") : undefined}
        onClose={() => {
          setIndex(null);
          document.documentElement.style.overflow = "";
        }}
        // 暗い部分（dialog 自身か、写真を囲む枠）をクリックしたら閉じる
        onClick={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.backdrop !== undefined) close();
        }}
        onKeyDown={(e) => {
          if (count < 2) return;
          if (e.key === "ArrowRight") step(1);
          else if (e.key === "ArrowLeft") step(-1);
        }}
        onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
        onTouchEnd={(e) => {
          const start = touchX.current;
          const end = e.changedTouches[0]?.clientX;
          touchX.current = null;
          if (count < 2 || start == null || end == null || Math.abs(end - start) < 50) return;
          step(end < start ? 1 : -1);
        }}
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 text-light backdrop:bg-black/85 open:animate-[photo-in_160ms_ease-out] motion-reduce:open:animate-none"
        data-testid="photo-viewer"
      >
        {current && (
          <div data-backdrop="" className="flex h-full w-full items-center justify-center p-4 sm:p-12">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img key={current.id} src={src(current.id)} alt="" className="max-h-full max-w-full select-none object-contain shadow-2xl" draggable={false} />
          </div>
        )}
        <button type="button" onClick={close} aria-label="閉じる" className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center text-2xl leading-none text-light/80 transition-colors hover:text-light">
          ×
        </button>
        {count > 1 && index !== null && (
          <>
            <button type="button" onClick={() => step(-1)} aria-label="前の写真" className="absolute left-1 top-1/2 flex h-14 w-11 -translate-y-1/2 items-center justify-center text-3xl text-light/70 transition-colors hover:text-light">
              ‹
            </button>
            <button type="button" onClick={() => step(1)} aria-label="次の写真" className="absolute right-1 top-1/2 flex h-14 w-11 -translate-y-1/2 items-center justify-center text-3xl text-light/70 transition-colors hover:text-light">
              ›
            </button>
            <p className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 text-xs tabular-nums tracking-[0.12em] text-light/70" aria-hidden>
              {index + 1} / {count}
            </p>
          </>
        )}
      </dialog>
    </>
  );
}

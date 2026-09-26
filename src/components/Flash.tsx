"use client";

import { useEffect, useState } from "react";

type Flash = { kind: "ok" | "error"; message: string };

/** サーバーアクションが残した 1 回限りの通知を表示し、Cookie を消す */
export function FlashToast({ flash }: { flash: Flash | null }) {
  const [shown, setShown] = useState<Flash | null>(flash);
  useEffect(() => {
    setShown(flash);
    if (!flash) return;
    document.cookie = "kakomi_flash=; Max-Age=0; path=/";
    const t = setTimeout(() => setShown(null), 5000);
    return () => clearTimeout(t);
  }, [flash]);
  if (!shown) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <div
        role={shown.kind === "error" ? "alert" : "status"}
        className={`fade-in pointer-events-auto px-5 py-3 text-sm tracking-[0.04em] shadow-lg ${
          shown.kind === "error" ? "bg-danger text-light" : "bg-ink text-light"
        }`}
      >
        {shown.message}
      </div>
    </div>
  );
}

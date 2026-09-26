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
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
      <div
        role={shown.kind === "error" ? "alert" : "status"}
        className={`pointer-events-auto rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg ${
          shown.kind === "error" ? "bg-danger text-white" : "bg-ink text-white"
        }`}
      >
        {shown.message}
      </div>
    </div>
  );
}

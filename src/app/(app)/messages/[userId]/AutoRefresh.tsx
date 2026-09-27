"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** 画面を開いている（見えている）間だけ、一定の間隔で最新の状態を取り直す */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return null;
}

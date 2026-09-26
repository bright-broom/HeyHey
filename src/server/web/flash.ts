import "server-only";
import { cookies } from "next/headers";

export type Flash = { kind: "ok" | "error"; message: string };
export const FLASH_COOKIE = "kakomi_flash";

/** 画面遷移をまたいで 1 回だけ出す通知。中身は機密を含まない短い文言だけ */
export async function setFlash(kind: Flash["kind"], message: string) {
  (await cookies()).set(FLASH_COOKIE, encodeURIComponent(JSON.stringify({ kind, message })), {
    httpOnly: false,
    sameSite: "lax",
    path: "/",
    maxAge: 30,
  });
}

export async function readFlash(): Promise<Flash | null> {
  const raw = (await cookies()).get(FLASH_COOKIE)?.value;
  if (!raw) return null;
  try {
    const v = JSON.parse(decodeURIComponent(raw));
    if ((v.kind === "ok" || v.kind === "error") && typeof v.message === "string") return { kind: v.kind, message: v.message.slice(0, 200) };
  } catch {}
  return null;
}

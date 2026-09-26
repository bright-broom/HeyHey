import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "../db/client";
import { isAdmin, isMember } from "../lib/policy";
import { toViewer, type Viewer } from "../lib/viewer";
import { userFromSession } from "../services/auth";

/** 本番（https）では __Host- 接頭辞＋Secure で、サブドメインや http からの上書きを防ぐ */
const SECURE = (process.env.APP_URL ?? "").startsWith("https://");
export const SESSION_COOKIE = SECURE ? "__Host-kakomi_session" : "kakomi_session";

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    expires: expiresAt,
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** リクエスト中は 1 回だけ DB を引く。状態（停止など）は毎リクエスト最新 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const db = await getDb();
  const user = await userFromSession(db, await readSessionToken());
  return user ? toViewer(user) : null;
});

/** アカウントの状態に応じて、見てよい画面へ振り分ける */
export function homeFor(v: Viewer | null): string {
  if (!v) return "/login";
  switch (v.status) {
    case "unverified":
    case "pending":
      return "/status";
    case "active":
      return v.termsAccepted ? "/" : "/welcome";
    default:
      return "/login?e=inactive";
  }
}

/** 会員向けページの入口。承認済み＋規約同意済み以外はここで止める */
export async function requireMember(): Promise<Viewer> {
  const v = await getViewer();
  if (!isMember(v)) redirect(homeFor(v));
  return v;
}

export async function requireAdmin(): Promise<Viewer> {
  const v = await requireMember();
  if (!isAdmin(v)) redirect("/");
  return v;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  // 信頼できるリバースプロキシ（Vercel 等）の後ろで動かす前提。最初の値だけを使う
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim().slice(0, 64);
}

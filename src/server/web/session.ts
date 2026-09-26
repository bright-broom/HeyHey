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

/**
 * レート制限用のクライアント IP。X-Forwarded-For はクライアントが自由に書けるので、
 * 信頼できるプロキシの後ろにいると明示された場合だけ使う。
 * - Vercel：プラットフォームが上書きする x-vercel-forwarded-for / x-real-ip
 * - TRUST_PROXY=1：自前のリバースプロキシ（nginx 等）が付けた X-Forwarded-For の右端
 * - それ以外：IP を区別しない（アカウント単位の制限は別途かかる）
 */
export async function clientIp(): Promise<string> {
  const h = await headers();
  let ip: string | null = null;
  if (process.env.VERCEL) {
    ip = h.get("x-vercel-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip");
  } else if (process.env.TRUST_PROXY === "1") {
    ip = h.get("x-forwarded-for")?.split(",").at(-1) ?? h.get("x-real-ip");
  }
  return (ip ?? "direct").trim().slice(0, 64);
}

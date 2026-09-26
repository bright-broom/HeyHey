"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { acceptTerms, changePassword, completeLogin, deleteSession, login, register, resendVerification, verifyEmail } from "@/server/services/auth";
import { safeLocalPath } from "@/server/lib/redirect";
import { toViewer } from "@/server/lib/viewer";
import { attempt, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import {
  clearChallengeCookie,
  clearSessionCookie,
  clientIp,
  getViewer,
  homeFor,
  readChallengeToken,
  readSessionToken,
  setChallengeCookie,
  setSessionCookie,
} from "@/server/web/session";

const LOGIN_MESSAGES = {
  invalid: "メールアドレスまたはパスワードが正しくありません。",
  rate_limited: "ログインの試行回数が上限に達しました。15 分ほど待ってから再度お試しください。",
  suspended: "このアカウントは利用停止中です。管理者にお問い合わせください。",
  rejected: "このアカウントではログインできません。",
  withdrawn: "メールアドレスまたはパスワードが正しくありません。",
  expired: "確認の有効期限が切れました。もう一度ログインしてください。",
} as const;

export async function loginAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const res = await login(db, { email: str(fd, "email"), password: str(fd, "password"), ip: await clientIp() });
  if (res.ok === false) return { error: LOGIN_MESSAGES[res.reason], fields: { email: str(fd, "email") } };
  const safeNext = safeLocalPath(str(fd, "next"));
  if (res.ok === "mfa") {
    await setChallengeCookie(res.challenge, res.expiresAt);
    redirect(safeNext ? `/login/2fa?next=${encodeURIComponent(safeNext)}` : "/login/2fa");
  }
  await setSessionCookie(res.token, res.expiresAt);
  const home = homeFor(toViewer(res.user, { mfa: res.mfa }));
  redirect(home === "/" && safeNext ? safeNext : home);
}

/** ログインの 2 段階目（認証アプリのコード、またはリカバリーコード） */
export async function loginCodeAction(_: FormState, fd: FormData): Promise<FormState> {
  const challenge = await readChallengeToken();
  if (!challenge) redirect("/login?e=mfa_expired");
  const res = await completeLogin(await getDb(), { challenge, code: str(fd, "code") });
  if (res.ok !== true) {
    if (res.ok === false && res.reason === "invalid") return { error: "確認コードが正しくありません。" };
    await clearChallengeCookie();
    if (res.ok === false && res.reason === "rate_limited") return { error: LOGIN_MESSAGES.rate_limited };
    redirect(res.ok === false && res.reason === "expired" ? "/login?e=mfa_expired" : "/login?e=inactive");
  }
  await clearChallengeCookie();
  await setSessionCookie(res.token, res.expiresAt);
  const safeNext = safeLocalPath(str(fd, "next"));
  const home = homeFor(toViewer(res.user, { mfa: res.mfa }));
  redirect(home === "/" && safeNext ? safeNext : home);
}

export async function logoutAction() {
  const token = await readSessionToken();
  if (token) await deleteSession(await getDb(), token);
  await clearSessionCookie();
  await clearChallengeCookie();
  redirect("/login");
}

export async function registerAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const fields = Object.fromEntries(
    ["email", "displayName", "fullName", "affiliation", "relationship", "introduction"].map((k) => [k, str(fd, k)]),
  );
  if (str(fd, "agree") !== "on") return { error: "利用規約とプライバシーポリシーへの同意が必要です。", fields };
  if (str(fd, "password") !== str(fd, "passwordConfirm")) return { error: "確認用パスワードが一致しません。", fields };
  const res = await attempt(async () => {
    await register(
      db,
      {
        token: str(fd, "token"),
        email: str(fd, "email"),
        password: str(fd, "password"),
        displayName: fields.displayName!,
        fullName: fields.fullName!,
        affiliation: fields.affiliation!,
        relationship: fields.relationship!,
        introduction: fields.introduction!,
      },
      { ip: await clientIp() },
    );
  });
  if (res?.error) return { ...res, fields };
  redirect("/join/sent");
}

export async function verifyAction(_: FormState, fd: FormData): Promise<FormState> {
  const { ok } = await verifyEmail(await getDb(), str(fd, "token"));
  if (!ok) return { error: "確認リンクが無効です。有効期限（24 時間）が切れたか、すでに使用済みです。" };
  return { ok: "メールアドレスを確認しました。管理者の審査が終わるとメールでお知らせします。" };
}

export async function resendVerificationAction(_: FormState, fd: FormData): Promise<FormState> {
  await resendVerification(await getDb(), str(fd, "email"), { ip: await clientIp() });
  // アドレスの登録有無を明かさないため、常に同じ応答
  return { ok: "登録済みで未確認のアドレスであれば、確認メールを再送しました。" };
}

export async function acceptTermsAction(fd: FormData) {
  const v = await getViewer();
  if (!v || v.status !== "active") redirect(homeFor(v));
  if (str(fd, "agree") !== "on") {
    await setFlash("error", "利用規約への同意が必要です。");
    redirect("/welcome");
  }
  await acceptTerms(await getDb(), v.id);
  redirect("/");
}

export async function changePasswordAction(_: FormState, fd: FormData): Promise<FormState> {
  const v = await getViewer();
  if (!v) redirect("/login");
  if (str(fd, "next") !== str(fd, "nextConfirm")) return { error: "確認用パスワードが一致しません。" };
  const db = await getDb();
  const res = await attempt(() => changePassword(db, v.id, str(fd, "current"), str(fd, "next")));
  if (res?.error) return res;
  // 全端末のセッションを破棄したので、ログインし直してもらう
  await clearSessionCookie();
  redirect("/login?e=password_changed");
}

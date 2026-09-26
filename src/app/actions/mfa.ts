"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { qrMatrix } from "@/server/lib/qr";
import { beginEnrollment, confirmEnrollment, disableMfa, regenerateRecoveryCodes } from "@/server/services/mfa";
import { str } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { getViewer, readSessionToken } from "@/server/web/session";

export type MfaFormState =
  | { error?: string; setup?: { secret: string; qr: boolean[][] }; recoveryCodes?: string[] }
  | undefined;

async function viewerOrLogin() {
  const v = await getViewer();
  if (!v) redirect("/login");
  return v;
}

/** 業務エラーは画面に出し、それ以外（バグ）はそのまま投げる */
async function run(fn: () => Promise<MfaFormState>): Promise<MfaFormState> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export async function beginMfaAction(_: MfaFormState): Promise<MfaFormState> {
  const v = await viewerOrLogin();
  return run(async () => {
    const { secret, uri } = await beginEnrollment(await getDb(), v);
    return { setup: { secret, qr: qrMatrix(uri) } };
  });
}

export async function confirmMfaAction(_: MfaFormState, fd: FormData): Promise<MfaFormState> {
  const v = await viewerOrLogin();
  const keepSessionToken = await readSessionToken();
  return run(async () => {
    const { recoveryCodes } = await confirmEnrollment(await getDb(), v, { password: str(fd, "password"), code: str(fd, "code"), keepSessionToken });
    return { recoveryCodes };
  });
}

export async function regenerateRecoveryAction(_: MfaFormState, fd: FormData): Promise<MfaFormState> {
  const v = await viewerOrLogin();
  return run(async () => regenerateRecoveryCodes(await getDb(), v, { code: str(fd, "code") }));
}

export async function disableMfaAction(_: MfaFormState, fd: FormData): Promise<MfaFormState> {
  const v = await viewerOrLogin();
  const res = await run(async () => {
    await disableMfa(await getDb(), v, { password: str(fd, "password"), code: str(fd, "code") });
    return undefined;
  });
  if (res?.error) return res;
  await setFlash("ok", "2 段階認証を無効にしました。");
  redirect("/settings/security");
}

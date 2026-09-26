"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { removeFriend, requestFriend, respondFriend } from "@/server/services/friends";
import { createInvitation, revokeInvitation } from "@/server/services/invites";
import { updateProfile, withdraw } from "@/server/services/members";
import { markAllRead } from "@/server/services/notifications";
import { attempt, files, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { clearSessionCookie, getViewer } from "@/server/web/session";

async function ctx() {
  return { db: await getDb(), viewer: await getViewer() };
}

async function quiet(fn: () => Promise<unknown>, okMessage?: string) {
  try {
    await fn();
    if (okMessage) await setFlash("ok", okMessage);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await setFlash("error", e.message);
  }
  refresh();
}

export async function friendAction(fd: FormData) {
  const { db, viewer } = await ctx();
  const other = str(fd, "userId");
  const op = str(fd, "op");
  await quiet(async () => {
    if (op === "request") await requestFriend(db, viewer!, other);
    else if (op === "accept") await respondFriend(db, viewer!, other, true);
    else if (op === "decline") await respondFriend(db, viewer!, other, false);
    else if (op === "remove") await removeFriend(db, viewer!, other);
  });
}

export async function createInviteAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  let url = "";
  const res = await attempt(async () => {
    const r = await createInvitation(db, viewer!, {
      note: str(fd, "note"),
      ...(str(fd, "maxUses") ? { maxUses: Number(str(fd, "maxUses")) } : {}),
      ...(str(fd, "ttlDays") ? { ttlDays: Number(str(fd, "ttlDays")) } : {}),
    });
    url = r.url;
  });
  if (res?.error) return res;
  refresh();
  // 招待 URL はこの応答でしか見られない（DB にはハッシュのみ）
  return { ok: url };
}

export async function revokeInviteAction(fd: FormData) {
  const { db, viewer } = await ctx();
  await quiet(() => revokeInvitation(db, viewer!, str(fd, "invitationId")), "招待リンクを取り消しました。");
}

export async function markAllReadAction() {
  const { db, viewer } = await ctx();
  await quiet(() => markAllRead(db, viewer!));
}

export async function updateProfileAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const [avatar] = await files(fd, "avatar");
  const res = await attempt(async () => {
    await updateProfile(db, viewer!, {
      displayName: str(fd, "displayName"),
      affiliation: str(fd, "affiliation"),
      bio: str(fd, "bio"),
      avatar: avatar ?? null,
      removeAvatar: str(fd, "removeAvatar") === "on",
    });
    return "プロフィールを更新しました。";
  });
  if (res?.ok) refresh();
  return res;
}

export async function withdrawAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  if (str(fd, "confirm") !== "退会する") return { error: "確認欄に「退会する」と入力してください。" };
  const res = await attempt(() =>
    withdraw(db, viewer!, { password: str(fd, "password"), mode: str(fd, "mode") as "delete" | "anonymize" }),
  );
  if (res?.error) return res;
  await clearSessionCookie();
  redirect("/login?e=withdrawn");
}

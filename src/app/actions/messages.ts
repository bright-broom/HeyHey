"use server";

import { refresh } from "next/cache";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { deleteMessage, sendMessage } from "@/server/services/messages";
import { attempt, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { getViewer } from "@/server/web/session";

export async function sendMessageAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const viewer = await getViewer();
  const res = await attempt(async () => {
    await sendMessage(db, viewer!, str(fd, "to"), str(fd, "body"));
  });
  if (res?.error) return { ...res, fields: { body: str(fd, "body") } };
  refresh();
  return res;
}

export async function deleteMessageAction(fd: FormData) {
  try {
    await deleteMessage(await getDb(), (await getViewer())!, str(fd, "messageId"));
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await setFlash("error", e.message);
  }
  refresh();
}

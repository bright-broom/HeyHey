"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { createEvent, deleteEvent, setEventCanceled, setEventHidden, setRsvp, updateEvent } from "@/server/services/events";
import { attempt, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { getViewer } from "@/server/web/session";

const fields = (fd: FormData) => ({
  title: str(fd, "title"),
  description: str(fd, "description"),
  location: str(fd, "location"),
  startsAt: str(fd, "startsAt"),
  endsAt: str(fd, "endsAt"),
});

export async function createEventAction(_: FormState, fd: FormData): Promise<FormState> {
  const db = await getDb();
  const viewer = await getViewer();
  let id = "";
  const res = await attempt(async () => {
    id = (await createEvent(db, viewer!, { ...fields(fd), groupId: str(fd, "groupId") })).id;
  });
  if (res?.error) return { ...res, fields: { ...fields(fd), groupId: str(fd, "groupId") } };
  await setFlash("ok", "イベントを作りました。");
  redirect(`/events/${id}`);
}

export async function updateEventAction(_: FormState, fd: FormData): Promise<FormState> {
  const id = str(fd, "eventId");
  const db = await getDb();
  const viewer = await getViewer();
  const res = await attempt(() => updateEvent(db, viewer!, id, fields(fd)));
  if (res?.error) return { ...res, fields: fields(fd) };
  await setFlash("ok", "イベントを更新しました。");
  redirect(`/events/${id}`);
}

/** 出欠・中止・削除・非表示。失敗はフラッシュで知らせる */
export async function eventOpAction(fd: FormData) {
  const db = await getDb();
  const viewer = (await getViewer())!;
  const id = str(fd, "eventId");
  const op = str(fd, "op");
  try {
    if (op === "rsvp") await setRsvp(db, viewer, id, str(fd, "status"));
    else if (op === "cancel") await setEventCanceled(db, viewer, id, true);
    else if (op === "reopen") await setEventCanceled(db, viewer, id, false);
    else if (op === "hide") await setEventHidden(db, viewer, id, true, str(fd, "reason"));
    else if (op === "unhide") await setEventHidden(db, viewer, id, false, "");
    else if (op === "delete") {
      await deleteEvent(db, viewer, id);
      await setFlash("ok", "イベントを削除しました。");
      redirect("/events");
    }
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await setFlash("error", e.message);
  }
  refresh();
}

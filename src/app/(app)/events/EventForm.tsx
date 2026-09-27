"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";
import type { FormState } from "@/server/web/action";

type Values = { title: string; description: string; location: string; startsAt: string; endsAt: string; groupId?: string };

/** イベントの作成・編集。日時は日本時間で入れる */
export function EventForm({
  action: serverAction,
  initial,
  eventId,
  groups,
  cancelHref,
}: {
  action: (s: FormState, fd: FormData) => Promise<FormState>;
  initial: Values;
  eventId?: string;
  groups?: { id: string; name: string }[];
  cancelHref: string;
}) {
  const [state, action] = useActionState(serverAction, undefined);
  const v = { ...initial, ...(state?.fields ?? {}) } as Values;
  return (
    <form action={action} className="card space-y-5 p-6">
      {eventId && <input type="hidden" name="eventId" value={eventId} />}
      <label className="block">
        <span className="label">タイトル</span>
        <input name="title" required maxLength={100} defaultValue={v.title} className="input mt-1.5" />
      </label>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block">
          <span className="label">開始（日本時間）</span>
          <input type="datetime-local" name="startsAt" required defaultValue={v.startsAt} className="input mt-1.5" />
        </label>
        <label className="block">
          <span className="label">終了（任意）</span>
          <input type="datetime-local" name="endsAt" defaultValue={v.endsAt} className="input mt-1.5" />
        </label>
      </div>
      <label className="block">
        <span className="label">場所（任意）</span>
        <input name="location" maxLength={200} defaultValue={v.location} placeholder="会場名やオンラインなど" className="input mt-1.5" />
      </label>
      <label className="block">
        <span className="label">説明（任意）</span>
        <textarea name="description" rows={5} maxLength={2000} defaultValue={v.description} className="input mt-1.5" />
      </label>
      {groups && (
        <label className="block">
          <span className="label">見せる相手</span>
          <select name="groupId" defaultValue={v.groupId ?? ""} className="input mt-1.5">
            <option value="">全会員</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                グループ「{g.name}」のメンバーだけ
              </option>
            ))}
          </select>
        </label>
      )}
      <FormMessage state={state} />
      <div className="flex gap-2">
        <SubmitButton>{eventId ? "保存する" : "作る"}</SubmitButton>
        <Link href={cancelHref} className="btn-ghost">
          キャンセル
        </Link>
      </div>
    </form>
  );
}

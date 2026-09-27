"use client";

import { useActionState } from "react";
import { createGroupAction, updateGroupAction } from "@/app/actions/groups";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

type Props = { group?: { id: string; name: string; description: string; joinPolicy: "open" | "approval" } };

/** グループの作成と設定の変更（同じ項目） */
export function GroupForm({ group }: Props) {
  const [state, action] = useActionState(group ? updateGroupAction : createGroupAction, undefined);
  return (
    <form action={action} className="space-y-5">
      {group && <input type="hidden" name="groupId" value={group.id} />}
      <div>
        <label htmlFor="g-name" className="label">グループ名</label>
        <input id="g-name" name="name" required maxLength={40} defaultValue={state?.fields?.name ?? group?.name} className="input" />
      </div>
      <div>
        <label htmlFor="g-desc" className="label">説明</label>
        <textarea id="g-desc" name="description" rows={3} maxLength={500} defaultValue={state?.fields?.description ?? group?.description} className="input" />
        <p className="hint">グループ名と説明は、コミュニティの全会員に表示されます。</p>
      </div>
      <fieldset className="space-y-2">
        <legend className="label">参加のしかた</legend>
        <label className="flex items-start gap-3 text-sm">
          <input type="radio" name="joinPolicy" value="approval" defaultChecked={(group?.joinPolicy ?? "approval") === "approval"} className="mt-1" />
          <span>
            承認制
            <span className="hint mt-0.5 block">参加するには、管理人の承認が必要です。</span>
          </span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="radio" name="joinPolicy" value="open" defaultChecked={group?.joinPolicy === "open"} className="mt-1" />
          <span>
            参加自由
            <span className="hint mt-0.5 block">会員なら誰でもすぐに参加できます。</span>
          </span>
        </label>
      </fieldset>
      <p className="hint">どちらの場合も、投稿はグループのメンバーにしか見えません。</p>
      <FormMessage state={state} />
      <SubmitButton className="btn-primary">{group ? "保存する" : "グループを作る"}</SubmitButton>
    </form>
  );
}

"use client";

import { useActionState } from "react";
import { memberAdminAction } from "@/app/actions/admin";
import { FormMessage } from "@/components/FormMessage";
import { SubmitButton } from "@/components/SubmitButton";

type Props = { userId: string; status: string; role: string; quota: number | null; viewerIsOwner: boolean; isSelf: boolean; targetMfa: boolean };

export function MemberActions({ userId, status, role, quota, viewerIsOwner, isSelf, targetMfa }: Props) {
  const [state, action] = useActionState(memberAdminAction, undefined);
  const canModerate = !isSelf && role !== "owner" && (role !== "admin" || viewerIsOwner);
  return (
    <div className="space-y-4">
      <FormMessage state={state} />
      {canModerate && status === "active" && (
        <form action={action} className="space-y-2">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="op" value="suspend" />
          <label htmlFor="reason" className="label">利用停止</label>
          <textarea id="reason" name="reason" rows={2} maxLength={500} required placeholder="停止理由（必須・監査ログに残ります）" className="input text-sm" />
          <SubmitButton className="btn-danger">利用停止にする</SubmitButton>
        </form>
      )}
      {canModerate && status === "suspended" && (
        <form action={action}>
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="op" value="reinstate" />
          <SubmitButton className="btn-primary">利用を再開する</SubmitButton>
        </form>
      )}
      {viewerIsOwner && !isSelf && role !== "owner" && status === "active" && (
        <form action={action} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="op" value="role" />
          <div>
            <label htmlFor="role" className="label">権限</label>
            <select id="role" name="role" defaultValue={role} className="input w-auto">
              <option value="member">一般</option>
              <option value="admin">管理者</option>
            </select>
          </div>
          <SubmitButton className="btn-ghost">変更</SubmitButton>
          {role === "member" && <p className="hint basis-full">管理者にすると全端末からログアウトされ、運営者の設定チケットで 2 段階認証を設定し直すまで管理機能は使えません。</p>}
        </form>
      )}
      {role === "member" && (
        <form action={action} className="flex items-end gap-2">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="op" value="quota" />
          <div>
            <label htmlFor="quota" className="label">招待枠（30 日あたり）</label>
            <input id="quota" name="quota" type="number" min={0} max={100} defaultValue={quota ?? ""} placeholder="既定 3" className="input w-32" />
          </div>
          <SubmitButton className="btn-ghost">保存</SubmitButton>
        </form>
      )}
      {viewerIsOwner && !isSelf && role === "admin" && status === "active" && (
        <form action={action} className="space-y-2 border-t border-line pt-4">
          <input type="hidden" name="userId" value={userId} />
          <input type="hidden" name="op" value="transfer" />
          <p className="label">オーナー権限を移す</p>
          {targetMfa ? (
            <>
              <p className="hint">移すと、あなたは管理者になります。取り消すには、相手から移し直してもらう必要があります。</p>
              <input name="password" type="password" autoComplete="current-password" required placeholder="あなたのパスワード" aria-label="あなたのパスワード" className="input text-sm" />
              <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required placeholder="認証アプリのコード" aria-label="認証アプリのコード" className="input text-sm tabular-nums" />
              <SubmitButton className="btn-danger">オーナー権限を移す</SubmitButton>
            </>
          ) : (
            <p className="hint">この管理者は 2 段階認証が未設定のため、まだ移せません。</p>
          )}
        </form>
      )}
    </div>
  );
}

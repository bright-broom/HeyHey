"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import {
  decideApplication,
  reinstateUser,
  setInviteQuota,
  setRole,
  suspendUser,
  type RejectReasonKey,
} from "@/server/services/admin";
import { resolveCase } from "@/server/services/reports";
import { attempt, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { getViewer } from "@/server/web/session";

async function ctx() {
  return { db: await getDb(), viewer: await getViewer() };
}

export async function decideApplicationAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const kind = str(fd, "kind");
  const id = str(fd, "applicationId");
  const res = await attempt(async () => {
    if (kind === "approve") await decideApplication(db, viewer!, id, { kind: "approve" });
    else if (kind === "reject") await decideApplication(db, viewer!, id, { kind: "reject", reasonKey: str(fd, "reasonKey") as RejectReasonKey, note: str(fd, "note") });
    else if (kind === "hold") await decideApplication(db, viewer!, id, { kind: "hold", note: str(fd, "note") });
    else throw new AppError("invalid", "操作を選んでください。");
    return { approve: "承認しました。", reject: "却下しました。", hold: "保留にしました。" }[kind];
  });
  // 処理した申請は一覧から消えてフォームごと外れるので、結果はトーストで出す
  if (res?.ok) {
    await setFlash("ok", res.ok);
    refresh();
  }
  return res;
}

export async function memberAdminAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const userId = str(fd, "userId");
  const op = str(fd, "op");
  const res = await attempt(async () => {
    switch (op) {
      case "suspend":
        await suspendUser(db, viewer!, userId, str(fd, "reason"));
        return "利用停止にしました。";
      case "reinstate":
        await reinstateUser(db, viewer!, userId);
        return "利用を再開しました。";
      case "role":
        await setRole(db, viewer!, userId, str(fd, "role") as "member" | "admin");
        return "権限を変更しました。";
      case "quota": {
        const raw = str(fd, "quota").trim();
        await setInviteQuota(db, viewer!, userId, raw === "" ? null : Number(raw));
        return "招待枠を変更しました。";
      }
      default:
        throw new AppError("invalid", "操作を選んでください。");
    }
  });
  if (res?.ok) refresh();
  return res;
}

export async function resolveReportAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const res = await attempt(() =>
    resolveCase(db, viewer!, {
      targetType: str(fd, "targetType") as "post" | "comment" | "user",
      targetId: str(fd, "targetId"),
      resolution: str(fd, "resolution"),
      note: str(fd, "note"),
    }),
  );
  if (res?.error) return res;
  await setFlash("ok", "通報を処理しました。");
  redirect("/admin/reports");
}

"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import {
  assignGroupOwnerByAdmin,
  createGroup,
  joinGroup,
  leaveGroup,
  removeMember,
  respondJoinRequest,
  setGroupArchived,
  transferGroupOwnership,
  unbanMember,
  updateGroup,
} from "@/server/services/groups";
import { attempt, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { getViewer } from "@/server/web/session";

async function ctx() {
  return { db: await getDb(), viewer: await getViewer() };
}

const groupInput = (fd: FormData) => ({
  name: str(fd, "name"),
  description: str(fd, "description"),
  joinPolicy: str(fd, "joinPolicy") as "open" | "approval",
});

export async function createGroupAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  let id = "";
  const res = await attempt(async () => {
    id = (await createGroup(db, viewer!, groupInput(fd))).id;
  });
  if (res?.error) return { ...res, fields: { name: str(fd, "name"), description: str(fd, "description") } };
  await setFlash("ok", "グループを作りました。");
  redirect(`/groups/${id}`);
}

export async function updateGroupAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const res = await attempt(async () => {
    await updateGroup(db, viewer!, str(fd, "groupId"), groupInput(fd));
    return "グループの設定を保存しました。";
  });
  if (res?.ok) refresh();
  return res;
}

/** 参加・退出・申請の承認など、画面遷移を伴わない操作。結果はフラッシュで知らせる */
export async function groupAction(fd: FormData) {
  const { db, viewer } = await ctx();
  const groupId = str(fd, "groupId");
  const userId = str(fd, "userId");
  const op = str(fd, "op");
  try {
    let message = "";
    switch (op) {
      case "join":
        message = (await joinGroup(db, viewer!, groupId)) === "joined" ? "グループに参加しました。" : "参加を申請しました。承認されるとお知らせが届きます。";
        break;
      case "leave":
        await leaveGroup(db, viewer!, groupId);
        message = "グループから退出しました。";
        break;
      case "approve":
        await respondJoinRequest(db, viewer!, groupId, userId, true);
        message = "参加を承認しました。";
        break;
      case "decline":
        await respondJoinRequest(db, viewer!, groupId, userId, false);
        message = "参加申請を見送りました。";
        break;
      case "remove":
        await removeMember(db, viewer!, groupId, userId);
        message = "メンバーを外しました。";
        break;
      case "transfer":
        await transferGroupOwnership(db, viewer!, groupId, userId);
        message = "管理人を移しました。";
        break;
      case "unban":
        await unbanMember(db, viewer!, groupId, userId);
        message = "除外を解除しました。また参加・申請できるようになります。";
        break;
      case "assign_owner":
        await assignGroupOwnerByAdmin(db, viewer!, groupId, userId);
        message = "管理人を指定しました。";
        break;
      case "archive":
      case "unarchive":
        await setGroupArchived(db, viewer!, groupId, op === "archive");
        message = op === "archive" ? "グループを閉じました。" : "グループを再開しました。";
        break;
      default:
        throw new AppError("invalid", "操作を選んでください。");
    }
    await setFlash("ok", message);
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await setFlash("error", e.message);
  }
  refresh();
}

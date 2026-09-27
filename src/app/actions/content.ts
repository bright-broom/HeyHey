"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { isMember } from "@/server/lib/policy";
import { searchMembers } from "@/server/services/members";
import { addComment, createPost, deleteComment, deletePost, toggleReaction, updatePost } from "@/server/services/posts";
import { createReport } from "@/server/services/reports";
import { attempt, files, str, type FormState } from "@/server/web/action";
import { setFlash } from "@/server/web/flash";
import { getViewer } from "@/server/web/session";

async function ctx() {
  return { db: await getDb(), viewer: await getViewer() };
}

/** 失敗しても画面遷移を伴わない操作（リアクションなど）は、フラッシュで知らせて再描画 */
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

/** 添付の一覧（隠し欄の JSON）。形が崩れていれば空として扱い、中身はサービス側で確かめる */
function parseAttachments(raw: string): { key: string; name: string }[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export async function createPostAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const images = await files(fd, "images");
  const res = await attempt(async () => {
    await createPost(db, viewer!, { body: str(fd, "body"), visibility: str(fd, "visibility"), images, attachments: parseAttachments(str(fd, "attachments")), groupId: str(fd, "groupId") || null });
    return "投稿しました。";
  });
  if (res?.ok) refresh();
  return res?.error ? { ...res, fields: { body: str(fd, "body") } } : res;
}

export async function updatePostAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const id = str(fd, "postId");
  const res = await attempt(() => updatePost(db, viewer!, id, { body: str(fd, "body"), visibility: str(fd, "visibility") }));
  if (res?.error) return res;
  await setFlash("ok", "投稿を更新しました。");
  redirect(`/posts/${id}`);
}

export async function deletePostAction(fd: FormData) {
  const { db, viewer } = await ctx();
  try {
    await deletePost(db, viewer!, str(fd, "postId"));
    await setFlash("ok", "投稿を削除しました。");
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    await setFlash("error", e.message);
  }
  redirect("/");
}

export async function commentAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  const res = await attempt(async () => {
    await addComment(db, viewer!, { postId: str(fd, "postId"), body: str(fd, "body"), parentId: str(fd, "parentId") || null });
  });
  if (!res?.error) refresh();
  return res?.error ? { ...res, fields: { body: str(fd, "body") } } : { ok: "sent" };
}

export async function deleteCommentAction(fd: FormData) {
  const { db, viewer } = await ctx();
  await quiet(() => deleteComment(db, viewer!, str(fd, "commentId")), "コメントを削除しました。");
}

export async function reactAction(fd: FormData) {
  const { db, viewer } = await ctx();
  const target = str(fd, "postId") ? { postId: str(fd, "postId") } : { commentId: str(fd, "commentId") };
  await quiet(() => toggleReaction(db, viewer!, target, str(fd, "type")));
}

export async function reportAction(_: FormState, fd: FormData): Promise<FormState> {
  const { db, viewer } = await ctx();
  let duplicated = false;
  const res = await attempt(async () => {
    const r = await createReport(db, viewer!, {
      targetType: str(fd, "targetType") as "post" | "comment" | "user",
      targetId: str(fd, "targetId"),
      reason: str(fd, "reason") as "spam",
      detail: str(fd, "detail"),
    });
    duplicated = r.duplicated;
  });
  if (res?.error) return res;
  return { ok: duplicated ? "この内容はすでに通報済みです。" : "通報を受け付けました。管理者が確認します。" };
}

/** メンションの候補（入力欄で @ の後に打った文字で検索）。ブロック関係の人は searchMembers が外す */
export async function suggestMembersAction(q: string): Promise<{ id: string; displayName: string; affiliation: string | null }[]> {
  const { db, viewer } = await ctx();
  if (!isMember(viewer) || typeof q !== "string") return [];
  const rows = await searchMembers(db, viewer, q.slice(0, 30));
  return rows
    .filter((r) => r.id !== viewer.id)
    .slice(0, 8)
    .map((r) => ({ id: r.id, displayName: r.displayName, affiliation: r.affiliation }));
}

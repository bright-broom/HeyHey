import { randomUUID } from "node:crypto";
import { getDb } from "@/server/db/client";
import { blobEnabled } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { authorizeStagingUpload } from "@/server/services/attachments";
import { storeFile } from "@/server/services/storage";
import { getViewer } from "@/server/web/session";

/**
 * ローカル（Blob なし）での動画・ファイルの一時置き場へのアップロード。本番（Blob あり）では 404。
 * PUT /api/uploads/local?ext=pdf に本文としてファイルを送ると、一時置き場のキーを返す。
 */
export async function PUT(req: Request) {
  if (blobEnabled()) return new Response("Not found", { status: 404 });
  const ext = new URL(req.url).searchParams.get("ext") ?? "";
  try {
    const viewer = await getViewer();
    const key = `staging/${viewer?.id ?? "none"}/${randomUUID()}.${ext}`;
    const rule = await authorizeStagingUpload(await getDb(), viewer, key);
    // 読む前に、申告された大きさで断る
    if (Number(req.headers.get("content-length") ?? 0) > rule.max) throw new AppError("invalid", `${rule.label}は ${rule.max / 1024 / 1024}MB までです。`);
    const data = Buffer.from(await req.arrayBuffer());
    if (data.byteLength > rule.max) throw new AppError("invalid", `${rule.label}は ${rule.max / 1024 / 1024}MB までです。`);
    await storeFile(key, data, rule.mime);
    return Response.json({ key }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof AppError ? e.message : "アップロードできませんでした。";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

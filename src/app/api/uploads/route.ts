import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { getDb } from "@/server/db/client";
import { blobEnabled } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import { authorizeStagingUpload } from "@/server/services/attachments";
import { getViewer } from "@/server/web/session";

/**
 * 動画・ファイルを、ブラウザから Vercel Blob の一時置き場へ直接上げるための許可を出す（本番用）。
 * Vercel Functions はリクエスト本文が 4.5MB までなので、大きなファイルはアプリを通さずに上げる。
 * 許可は「自分の一時置き場のそのキー」「その種類の Content-Type」「その種類の上限サイズ」に限る。
 * 投稿するときに、サーバーが中身を確かめてから本置き場に移す（attachments.ts）。
 */
export async function POST(req: Request) {
  if (!blobEnabled()) return new Response("Not found", { status: 404 });
  // ほかのサイトから許可を発行させない（フォーム送信などで Cookie 付きの POST を送られても断る）
  const origin = req.headers.get("origin");
  if (!origin || origin !== new URL(req.url).origin) return new Response("Forbidden", { status: 403 });
  const body = (await req.json()) as HandleUploadBody;
  // 完了の通知（Blob からのコールバック）は使わない。投稿時に確かめるので、ここでは許可の発行だけを受け付ける
  if (body.type !== "blob.generate-client-token") return new Response("Not found", { status: 404 });
  try {
    const db = await getDb();
    const viewer = await getViewer();
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        const key = pathname.replace(/^media\//, "");
        if (`media/${key}` !== pathname) throw new AppError("invalid", "アップロード先が正しくありません。");
        const rule = await authorizeStagingUpload(db, viewer, key);
        return {
          allowedContentTypes: rule.mime === "video/mp4" ? ["video/mp4", "video/quicktime"] : [rule.mime],
          maximumSizeInBytes: rule.max,
          addRandomSuffix: false,
          allowOverwrite: false,
          validUntil: Date.now() + 30 * 60 * 1000,
        };
      },
    });
    return Response.json(json, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = e instanceof AppError ? e.message : "アップロードを始められませんでした。";
    return Response.json({ error: message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
}

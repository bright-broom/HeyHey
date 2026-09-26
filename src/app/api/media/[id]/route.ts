import { getDb } from "@/server/db/client";
import { mediaForViewer } from "@/server/services/media";
import { readStoredFile } from "@/server/services/storage";
import { getViewer } from "@/server/web/session";

/**
 * 画像配信。毎回ログイン状態と公開範囲を確認してから返す。
 * 見えない画像は 404（存在の有無も明かさない）。ブラウザにも共有キャッシュにも保存させない。
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  const notFound = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  const found = await mediaForViewer(await getDb(), await getViewer(), id);
  if (!found) return notFound();
  const body = await readStoredFile(found.storageKey);
  if (!body) return notFound();
  return new Response(Buffer.isBuffer(body) ? new Uint8Array(body) : (body as ReadableStream<Uint8Array>), {
    headers: {
      "Content-Type": found.mime,
      "Content-Length": String(found.bytes),
      // 共有端末でログアウト・友達解除・停止の後にキャッシュから見えないよう、保存させない
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

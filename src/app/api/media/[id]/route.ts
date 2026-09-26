import fs from "node:fs/promises";
import { getDb } from "@/server/db/client";
import { mediaForViewer } from "@/server/services/media";
import { getViewer } from "@/server/web/session";

/**
 * 画像配信。毎回ログイン状態と公開範囲を確認してから返す。
 * 見えない画像は 404（存在の有無も明かさない）。共有キャッシュには載せない。
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  const found = await mediaForViewer(await getDb(), await getViewer(), id);
  if (!found) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  let data: Buffer;
  try {
    data = await fs.readFile(found.filePath);
  } catch {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": found.mime,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "private, max-age=600",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

import { getDb } from "@/server/db/client";
import { mediaForViewer } from "@/server/services/media";
import { readStoredFile } from "@/server/services/storage";
import { getViewer } from "@/server/web/session";

/** 動画のシーク再生のための範囲指定（bytes=start-end の 1 区間だけに対応） */
function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return "invalid";
  let start = m[1] ? Number(m[1]) : size - Number(m[2]);
  let end = m[1] && m[2] ? Number(m[2]) : size - 1;
  start = Math.max(0, start);
  end = Math.min(end, size - 1);
  return start > end ? "invalid" : { start, end };
}

/** Content-Disposition のファイル名（日本語は RFC 5987 の形で） */
const disposition = (kind: "inline" | "attachment", name: string | null) =>
  name ? `${kind}; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}` : kind;

/**
 * 画像・動画・ファイルの配信。毎回ログイン状態と公開範囲を確認してから返す。
 * 見えないものは 404（存在の有無も明かさない）。ブラウザにも共有キャッシュにも保存させない。
 * 画像と動画はページの中で表示し、ファイル（PDF・Office）は必ずダウンロードさせる（ブラウザの中で開かせない）。
 */
export async function GET(req: Request, ctx: RouteContext<"/api/media/[id]">) {
  const { id } = await ctx.params;
  const noStore = { "Cache-Control": "private, no-store" };
  const notFound = () => new Response("Not found", { status: 404, headers: noStore });
  const found = await mediaForViewer(await getDb(), await getViewer(), id);
  if (!found) return notFound();
  const isVideo = found.mime.startsWith("video/");
  const range = isVideo ? parseRange(req.headers.get("range"), found.bytes) : null;
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...noStore, "Content-Range": `bytes */${found.bytes}` } });
  const read = await readStoredFile(found.storageKey, range ?? undefined);
  if (!read) return notFound();
  const inline = found.mime.startsWith("image/") || isVideo;
  const headers: Record<string, string> = {
    ...noStore,
    "Content-Type": found.mime,
    // 共有端末でログアウト・友達解除・停止の後にキャッシュから見えないよう、保存させない
    "Content-Disposition": disposition(inline ? "inline" : "attachment", found.fileName),
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    ...(isVideo ? { "Accept-Ranges": "bytes" } : {}),
  };
  if (read.range) {
    headers["Content-Range"] = `bytes ${read.range.start}-${read.range.end}/${found.bytes}`;
    headers["Content-Length"] = String(read.range.end - read.range.start + 1);
  } else {
    headers["Content-Length"] = String(found.bytes);
  }
  const body = Buffer.isBuffer(read.body) ? new Uint8Array(read.body) : read.body;
  return new Response(body, { status: read.range ? 206 : 200, headers });
}

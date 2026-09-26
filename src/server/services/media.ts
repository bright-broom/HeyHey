import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp, { type Metadata } from "sharp";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { media, posts, reports, users } from "../db/schema";
import { invalid } from "../lib/errors";
import { isAdmin, isMember } from "../lib/policy";
import { visiblePost } from "../lib/visibility";
import type { Viewer } from "../lib/viewer";

export const MAX_IMAGES_PER_POST = 4;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_EDGE = 2048;
const ALLOWED_INPUT = new Set(["jpeg", "png", "webp", "gif"]);

function uploadDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "uploads"));
}

export type ProcessedImage = { key: string; width: number; height: number; bytes: number; mime: string };

/**
 * 画像の取り込み。中身を sharp でデコードできたものだけ受け付け、
 * WebP に再エンコードする（EXIF・位置情報などのメタデータはここで全て落ちる）。
 * 拡張子や Content-Type は信用しない。
 */
export async function processImage(input: Buffer, opts: { square?: number } = {}): Promise<ProcessedImage> {
  if (input.byteLength === 0) throw invalid("空のファイルはアップロードできません。");
  if (input.byteLength > MAX_IMAGE_BYTES) throw invalid("画像は 1 枚 8MB までです。");
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw invalid("画像ファイルとして読み込めませんでした（JPEG / PNG / WebP / GIF に対応）。");
  }
  if (!meta.format || !ALLOWED_INPUT.has(meta.format)) {
    throw invalid("対応していない画像形式です（JPEG / PNG / WebP / GIF に対応）。");
  }
  let pipeline = sharp(input, { limitInputPixels: 40_000_000 }).rotate(); // EXIF の向きを反映してから捨てる
  pipeline = opts.square
    ? pipeline.resize(opts.square, opts.square, { fit: "cover" })
    : pipeline.resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true });
  const { data, info } = await pipeline.webp({ quality: 82 }).toBuffer({ resolveWithObject: true });

  const key = `${randomUUID()}.webp`;
  await fs.mkdir(uploadDir(), { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ uploadDir(), key), data, { mode: 0o600 });
  return { key, width: info.width, height: info.height, bytes: data.byteLength, mime: "image/webp" };
}

export async function removeStoredFile(key: string): Promise<void> {
  if (!/^[0-9a-f-]{36}\.webp$/.test(key)) return;
  await fs.rm(path.join(/*turbopackIgnore: true*/ uploadDir(), key), { force: true });
}

/**
 * 画像配信の認可。投稿画像は「その投稿が見えるか」を visiblePost で判定し、
 * アバターは承認済み会員なら誰でも見られる。見えない場合は存在自体を隠して null。
 */
export async function mediaForViewer(db: Db, viewer: Viewer | null, mediaId: string) {
  if (!isMember(viewer)) return null;
  if (!/^[0-9a-f-]{36}$/i.test(mediaId)) return null;
  const [m] = await db.select().from(media).where(eq(media.id, mediaId)).limit(1);
  if (!m) return null;

  if (m.kind === "avatar") {
    const [owner] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, m.ownerId), sql`${users.status} IN ('active')`));
    if (!owner) return null;
  } else {
    if (!m.postId) return null;
    const [p] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.id, m.postId), visiblePost(viewer.id)));
    // 管理者は「未処理の通報がある投稿」に限り、公開範囲外・非表示でも画像を確認できる（閲覧は getCase で監査ログ済み）
    const reportedForAdmin =
      !p && isAdmin(viewer)
        ? (await db.select({ id: reports.id }).from(reports).where(and(eq(reports.targetType, "post"), eq(reports.targetId, m.postId), eq(reports.status, "open"))).limit(1)).length > 0
        : false;
    if (!p && !reportedForAdmin) return null;
  }
  const filePath = path.join(/*turbopackIgnore: true*/ uploadDir(), m.storageKey);
  return { filePath, mime: m.mime, bytes: m.bytes };
}

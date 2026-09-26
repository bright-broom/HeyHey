import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { blobEnabled } from "../lib/env";

/**
 * 画像ファイルの置き場所。
 * - Vercel Blob のトークンがあれば Blob（private）に保存する。private なので URL を知っていても
 *   直接は読めず、必ずアプリの /api/media（ログイン・公開範囲チェック付き）を通る
 * - なければローカルディスク（UPLOAD_DIR、既定 .data/uploads）
 */
const useBlob = blobEnabled;
const KEY_RE = /^[0-9a-f-]{36}\.webp$/;
const blobPath = (key: string) => `media/${key}`;

function uploadDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "uploads"));
}

export async function storeFile(key: string, data: Buffer, contentType: string): Promise<void> {
  if (!KEY_RE.test(key)) throw new Error("invalid storage key");
  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(blobPath(key), data, { access: "private", contentType, addRandomSuffix: false });
    return;
  }
  await fs.mkdir(uploadDir(), { recursive: true });
  await fs.writeFile(path.join(/*turbopackIgnore: true*/ uploadDir(), key), data, { mode: 0o600 });
}

export async function readStoredFile(key: string): Promise<ReadableStream<Uint8Array> | Buffer | null> {
  if (!KEY_RE.test(key)) return null;
  if (useBlob()) {
    const { get } = await import("@vercel/blob");
    const res = await get(blobPath(key), { access: "private" });
    return res?.statusCode === 200 ? res.stream : null;
  }
  try {
    return await fs.readFile(path.join(/*turbopackIgnore: true*/ uploadDir(), key));
  } catch {
    return null;
  }
}

export async function removeStoredFile(key: string): Promise<void> {
  if (!KEY_RE.test(key)) return;
  if (useBlob()) {
    const { del } = await import("@vercel/blob");
    await del(blobPath(key)).catch(() => {});
    return;
  }
  await fs.rm(path.join(/*turbopackIgnore: true*/ uploadDir(), key), { force: true });
}

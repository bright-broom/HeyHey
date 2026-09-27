import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import { blobEnabled } from "../lib/env";

/**
 * 画像・動画・ファイルの置き場所。
 * - Vercel Blob のトークンがあれば Blob（private）に保存する。private なので URL を知っていても
 *   直接は読めず、必ずアプリの /api/media（ログイン・公開範囲チェック付き）を通る
 * - なければローカルディスク（UPLOAD_DIR、既定 .data/uploads）
 *
 * 動画とファイルは大きいので、ブラウザからまず一時置き場（staging/会員ID/…）に上げ、
 * 投稿するときにサーバーが中身を確かめてから本置き場に移す（attachments.ts）。
 */
const useBlob = blobEnabled;
export const STORED_EXTS = ["webp", "mp4", "pdf", "docx", "xlsx", "pptx"] as const;
const KEY_RE = new RegExp(`^[0-9a-f-]{36}\\.(${STORED_EXTS.join("|")})$`);
/** 一時置き場のキー：staging/<会員ID>/<ランダム>.<拡張子> */
export const STAGING_RE = /^staging\/([0-9a-f-]{36})\/[0-9a-f-]{36}\.(mp4|mov|pdf|docx|xlsx|pptx)$/;
const blobPath = (key: string) => `media/${key}`;
const validKey = (key: string) => KEY_RE.test(key) || STAGING_RE.test(key);

function uploadDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), ".data", "uploads"));
}
const diskPath = (key: string) => path.join(/*turbopackIgnore: true*/ uploadDir(), key);

export async function storeFile(key: string, data: Buffer, contentType: string): Promise<void> {
  if (!validKey(key)) throw new Error("invalid storage key");
  if (useBlob()) {
    const { put } = await import("@vercel/blob");
    await put(blobPath(key), data, { access: "private", contentType, addRandomSuffix: false });
    return;
  }
  await fs.mkdir(path.dirname(diskPath(key)), { recursive: true });
  await fs.writeFile(diskPath(key), data, { mode: 0o600 });
}

export type StoredRead = { body: ReadableStream<Uint8Array> | Buffer; range?: { start: number; end: number } };

/** 保存したファイルを読む。range を渡すとその範囲だけ（動画のシーク再生用） */
export async function readStoredFile(key: string, range?: { start: number; end: number }): Promise<StoredRead | null> {
  if (!validKey(key)) return null;
  if (useBlob()) {
    const { get } = await import("@vercel/blob");
    const res = await get(blobPath(key), { access: "private", headers: range ? { Range: `bytes=${range.start}-${range.end}` } : undefined });
    if (res?.statusCode !== 200) return null;
    // Blob が範囲指定に応じなかった（206 でない）ときは、範囲なしの全体として扱う
    return { body: res.stream, range: range && res.headers.get("content-range") ? range : undefined };
  }
  try {
    if (!range) return { body: await fs.readFile(diskPath(key)) };
    const fh = await fs.open(diskPath(key), "r");
    try {
      const buf = Buffer.alloc(range.end - range.start + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, range.start);
      return { body: buf.subarray(0, bytesRead), range };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/** 一時置き場のファイルを丸ごと読む（上限を超えていたら null） */
export async function readStagedFile(key: string, maxBytes: number): Promise<Buffer | null> {
  if (!STAGING_RE.test(key)) return null;
  const r = await readStoredFile(key);
  if (!r) return null;
  if (Buffer.isBuffer(r.body)) return r.body.byteLength > maxBytes ? null : r.body;
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function removeStoredFile(key: string): Promise<void> {
  if (!validKey(key)) return;
  if (useBlob()) {
    const { del } = await import("@vercel/blob");
    await del(blobPath(key)).catch(() => {});
    return;
  }
  await fs.rm(diskPath(key), { force: true });
}

/** 一時置き場に olderThan より前から残っているファイルを消す（投稿されなかったアップロード）。消した数を返す */
export async function purgeStaleStaging(olderThan: Date): Promise<number> {
  let n = 0;
  if (useBlob()) {
    const { list, del } = await import("@vercel/blob");
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: "media/staging/", cursor, limit: 1000 });
      const stale = page.blobs.filter((b) => b.uploadedAt < olderThan).map((b) => b.pathname);
      if (stale.length) await del(stale);
      n += stale.length;
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return n;
  }
  const root = path.join(/*turbopackIgnore: true*/ uploadDir(), "staging");
  const dirs = await fs.readdir(root).catch(() => [] as string[]);
  for (const d of dirs) {
    for (const f of await fs.readdir(path.join(/*turbopackIgnore: true*/ root, d)).catch(() => [] as string[])) {
      const p = path.join(/*turbopackIgnore: true*/ root, d, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtime < olderThan) {
        await fs.rm(p, { force: true });
        n++;
      }
    }
  }
  return n;
}

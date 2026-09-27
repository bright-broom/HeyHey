import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/client";
import { AppError, invalid } from "../lib/errors";
import { assertMember } from "../lib/policy";
import { Mp4Error, stripMp4Metadata } from "../lib/mp4";
import type { Viewer } from "../lib/viewer";
import { consume } from "./ratelimit";
import { countStaging, purgeStaleStaging, readStagedFile, removeStoredFile, STAGING_RE, storeFile } from "./storage";

/**
 * 動画・ファイルの添付（F-13）。
 *
 * ブラウザは一時置き場（staging/<自分の会員ID>/…）にだけ上げられる（/api/uploads が発行する許可で）。
 * 投稿するときにここで、自分の一時置き場のものか・大きさ・中身の形式（先頭のバイト列）を確かめ、
 * 動画は位置情報などのメタデータを消してから本置き場に移す。拡張子や Content-Type は信用しない。
 */
export const MAX_ATTACHMENTS_PER_POST = 2;

type Rule = { label: string; mime: string; ext: "mp4" | "pdf" | "docx" | "xlsx" | "pptx"; max: number; sniff: (b: Buffer) => boolean };
const MB = 1024 * 1024;
const isFtyp = (b: Buffer) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp";
const isZip = (b: Buffer) => b.length > 4 && b.readUInt32BE(0) === 0x504b0304;
/** Office 文書は zip で、[Content_Types].xml と種類ごとのフォルダ（word/・xl/・ppt/）を持つ */
const isOffice = (dir: string) => (b: Buffer) => isZip(b) && b.includes("[Content_Types].xml") && b.includes(`${dir}/`);

export const ATTACHMENT_RULES: Record<string, Rule> = {
  mp4: { label: "動画", mime: "video/mp4", ext: "mp4", max: 50 * MB, sniff: isFtyp },
  mov: { label: "動画", mime: "video/mp4", ext: "mp4", max: 50 * MB, sniff: isFtyp },
  pdf: { label: "PDF", mime: "application/pdf", ext: "pdf", max: 20 * MB, sniff: (b) => b.toString("latin1", 0, 5) === "%PDF-" },
  docx: { label: "Word", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx", max: 20 * MB, sniff: isOffice("word") },
  xlsx: { label: "Excel", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx", max: 20 * MB, sniff: isOffice("xl") },
  pptx: { label: "PowerPoint", mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx", max: 20 * MB, sniff: isOffice("ppt") },
};

/** ブラウザに見せるファイル名。パスや制御文字を除き、100 文字まで */
export function cleanFileName(name: string, ext: string): string {
  const base = name
    .split(/[\\/]/)
    .pop()!
    // 制御文字と、表示の向きを変える文字（拡張子を偽って見せる手口に使われる）を除く
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069"<>|:*?]/g, "")
    .replace(/\.[^.]*$/, "")
    .trim()
    .slice(0, 100);
  return `${base || "file"}.${ext}`;
}

/** 一時置き場のキーから拡張子の規則を引く。自分の一時置き場のものでなければ null */
export function stagingRuleFor(viewer: Viewer, key: string): Rule | null {
  const m = key.match(STAGING_RE);
  if (!m || m[1] !== viewer.id) return null;
  return ATTACHMENT_RULES[m[2]!] ?? null;
}

/** 1 時間に一時置き場へ上げられる数と、投稿せずに置いておける数（容量を使い潰させない） */
const UPLOADS_PER_HOUR = 12;
export const MAX_STAGED = 4;
/** これより古い一時置き場のファイルは、次に上げるときに消す（定期処理でも消す） */
export const STAGING_TTL_MS = 60 * 60 * 1000;

/**
 * 一時置き場へのアップロードを許すか。承認済み会員が、自分の一時置き場の、許した種類のキーに上げるときだけ。
 * 返り値の規則で、大きさの上限と Content-Type を Blob の許可にも書き込む。
 */
export async function authorizeStagingUpload(db: Db, viewer: Viewer | null, key: string): Promise<Rule> {
  assertMember(viewer);
  const rule = stagingRuleFor(viewer, key);
  if (!rule) throw invalid("この種類のファイルは添付できません（動画は MP4 / MOV、ファイルは PDF・Word・Excel・PowerPoint）。");
  if (!(await consume(db, `upload:${viewer.id}`, UPLOADS_PER_HOUR, 60 * 60))) {
    throw new AppError("rate_limited", "短時間にアップロードが集中しています。少し時間をおいてください。");
  }
  await purgeStaleStaging(new Date(Date.now() - STAGING_TTL_MS), viewer.id);
  if ((await countStaging(viewer.id)) >= MAX_STAGED) {
    throw new AppError("rate_limited", "投稿していない添付が多すぎます。いったん投稿するか、1 時間ほどおいてからやり直してください。");
  }
  return rule;
}

export const attachmentInput = z.array(z.object({ key: z.string().max(200), name: z.string().max(300) })).max(MAX_ATTACHMENTS_PER_POST, `動画・ファイルは ${MAX_ATTACHMENTS_PER_POST} 件までです。`);
export type AttachmentInput = z.infer<typeof attachmentInput>;

export type ProcessedAttachment = { key: string; mime: string; bytes: number; fileName: string };

/** 一時置き場のファイルを確かめて本置き場に移す。失敗したら invalid を投げる（一時置き場のものは消す） */
export async function claimAttachment(viewer: Viewer, input: { key: string; name: string }): Promise<ProcessedAttachment> {
  const rule = stagingRuleFor(viewer, input.key);
  if (!rule) throw invalid("添付ファイルが見つかりません。もう一度選んでください。");
  try {
    const data = await readStagedFile(input.key, rule.max);
    if (!data) throw invalid(`${rule.label}は ${rule.max / MB}MB までです（見つからない場合は、もう一度選んでください）。`);
    if (!rule.sniff(data)) throw invalid(`${rule.label}のファイルとして読み込めませんでした。`);
    let out = data;
    if (rule.mime.startsWith("video/")) {
      try {
        out = stripMp4Metadata(data); // その場で書き換える（大きな動画を 2 重に持たない）
      } catch (e) {
        if (!(e instanceof Mp4Error)) throw e;
        throw invalid("この動画は受け付けられません（撮影場所などの情報を確実に消せない形式です）。スマホのカメラで撮った MP4 / MOV をお使いください。");
      }
    }
    const key = `${randomUUID()}.${rule.ext}`;
    await storeFile(key, out, rule.mime);
    return { key, mime: rule.mime, bytes: out.byteLength, fileName: cleanFileName(input.name, rule.ext) };
  } finally {
    await removeStoredFile(input.key);
  }
}

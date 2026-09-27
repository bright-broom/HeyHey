import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "../db/client";
import { AppError, invalid } from "../lib/errors";
import { assertMember } from "../lib/policy";
import type { Viewer } from "../lib/viewer";
import { consume } from "./ratelimit";
import { readStagedFile, removeStoredFile, STAGING_RE, storeFile } from "./storage";

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
    .replace(/[\u0000-\u001f\u007f"<>|:*?]/g, "")
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

/** 1 時間に一時置き場へ上げられる数（容量を使い潰させない） */
const UPLOADS_PER_HOUR = 30;

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
    const out = rule.mime.startsWith("video/") ? stripMp4Metadata(data) : data;
    const key = `${randomUUID()}.${rule.ext}`;
    await storeFile(key, out, rule.mime);
    return { key, mime: rule.mime, bytes: out.byteLength, fileName: cleanFileName(input.name, rule.ext) };
  } finally {
    await removeStoredFile(input.key);
  }
}

/**
 * mp4 / mov のメタデータ（撮影場所・機種・作成者など）を消す。
 * moov・trak の中の udta / meta / uuid / XMP_ の箱を、中身をゼロで塗りつぶした free（空き領域）に書き換える
 * （種類だけ変えると、座標などの文字がファイルの中に残る）。
 * 箱の大きさも位置も変えないので、映像・音声のデータの参照（オフセット）は壊れない。
 */
const CONTAINERS = new Set(["moov", "trak"]);
const METADATA = new Set(["udta", "meta", "uuid", "XMP_"]);

export function stripMp4Metadata(input: Buffer): Buffer {
  const out = Buffer.from(input);
  const walk = (start: number, end: number) => {
    let p = start;
    while (p + 8 <= end) {
      let size = out.readUInt32BE(p);
      const type = out.toString("latin1", p + 4, p + 8);
      let header = 8;
      if (size === 1) {
        if (p + 16 > end) return;
        size = Number(out.readBigUInt64BE(p + 8));
        header = 16;
      } else if (size === 0) {
        size = end - p;
      }
      if (size < header || p + size > end) return;
      if (METADATA.has(type)) {
        out.write("free", p + 4, "latin1");
        out.fill(0, p + header, p + size);
      }
      else if (CONTAINERS.has(type)) walk(p + header, p + size);
      p += size;
    }
  };
  walk(0, out.length);
  return out;
}

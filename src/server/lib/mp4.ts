/**
 * MP4 / MOV（ISO BMFF）から、撮影場所・日時・機種などを消す。受け取ったバッファをその場で書き換える
 * （大きな動画を 2 重に持たないため）。箱の大きさと位置は変えないので、再生に必要なオフセットは壊れない。
 *
 * 1. メタデータの箱（udta・meta・uuid・XMP_）を、中身をゼロにした free にする
 * 2. 映像・音声以外のトラック（GoPro の GPS、ドローンの位置の字幕、Apple の mebx など）は、
 *    mdat の中のそのトラックのデータをゼロで塗り、トラックの箱も中身をゼロにした free にする
 * 3. mvhd・tkhd・mdhd の作成日時・更新日時を 0 にする
 *
 * 後から足していく形式（moof を持つ fragmented MP4）は、位置のデータを確実に消せないので受け付けない。
 */
export class Mp4Error extends Error {}

type Box = { type: string; start: number; header: number; end: number };

function readBoxes(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) throw new Mp4Error("broken box");
      const big = buf.readBigUInt64BE(p + 8);
      if (big > BigInt(end - p)) throw new Mp4Error("broken box");
      size = Number(big);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) throw new Mp4Error("broken box");
    out.push({ type, start: p, header, end: p + size });
    p += size;
  }
  return out;
}

const child = (buf: Buffer, parent: Box, type: string) => readBoxes(buf, parent.start + parent.header, parent.end).find((b) => b.type === type);
const METADATA = new Set(["udta", "meta", "uuid", "XMP_"]);

/** 箱を「中身がゼロの free」にする */
function blank(buf: Buffer, b: Box) {
  buf.write("free", b.start + 4, "latin1");
  buf.fill(0, b.start + b.header, b.end);
}

/** mvhd・tkhd・mdhd の作成日時と更新日時（version 0 は 4 バイトずつ、1 は 8 バイトずつ）を 0 にする */
function clearTimes(buf: Buffer, b: Box) {
  const body = b.start + b.header;
  if (body + 4 > b.end) return;
  const width = buf[body] === 1 ? 8 : 4;
  const to = Math.min(body + 4 + width * 2, b.end);
  buf.fill(0, body + 4, to);
}

/** トラックのサンプルが mdat のどこにあるか（chunk の位置と大きさ）を stbl から求めて、ゼロで塗る */
function blankSamples(buf: Buffer, stbl: Box) {
  const stsz = child(buf, stbl, "stsz");
  const stsc = child(buf, stbl, "stsc");
  const stco = child(buf, stbl, "stco") ?? child(buf, stbl, "co64");
  if (!stsz || !stsc || !stco) throw new Mp4Error("missing sample table");
  const at = (b: Box) => b.start + b.header + 4; // version・flags の後
  // サンプルの大きさ
  const fixed = buf.readUInt32BE(at(stsz));
  const count = buf.readUInt32BE(at(stsz) + 4);
  const sizeOf = (i: number) => (fixed ? fixed : buf.readUInt32BE(at(stsz) + 8 + i * 4));
  // chunk の位置
  const chunks = buf.readUInt32BE(at(stco));
  const wide = stco.type === "co64";
  const offsetOf = (i: number) => (wide ? Number(buf.readBigUInt64BE(at(stco) + 4 + i * 8)) : buf.readUInt32BE(at(stco) + 4 + i * 4));
  // chunk ごとのサンプル数（first_chunk は 1 始まり）
  const runs = buf.readUInt32BE(at(stsc));
  const perChunk = (c: number) => {
    let n = 0;
    for (let r = 0; r < runs; r++) {
      const first = buf.readUInt32BE(at(stsc) + 4 + r * 12);
      if (first - 1 > c) break;
      n = buf.readUInt32BE(at(stsc) + 4 + r * 12 + 4);
    }
    return n;
  };
  if (!fixed && at(stsz) + 8 + count * 4 > stsz.end) throw new Mp4Error("broken stsz");
  if (at(stco) + 4 + chunks * (wide ? 8 : 4) > stco.end || at(stsc) + 4 + runs * 12 > stsc.end) throw new Mp4Error("broken chunk table");
  let sample = 0;
  for (let c = 0; c < chunks && sample < count; c++) {
    let len = 0;
    for (let k = perChunk(c); k > 0 && sample < count; k--) len += sizeOf(sample++);
    const off = offsetOf(c);
    if (off < 0 || off + len > buf.length) throw new Mp4Error("sample out of range");
    buf.fill(0, off, off + len);
  }
}

export function stripMp4Metadata(buf: Buffer): Buffer {
  const top = readBoxes(buf, 0, buf.length);
  if (top[0]?.type !== "ftyp") throw new Mp4Error("not mp4");
  if (top.some((b) => b.type === "moof")) throw new Mp4Error("fragmented mp4");
  const moov = top.find((b) => b.type === "moov");
  if (!moov) throw new Mp4Error("no moov");
  for (const b of top) if (METADATA.has(b.type)) blank(buf, b);
  for (const b of readBoxes(buf, moov.start + moov.header, moov.end)) {
    if (METADATA.has(b.type)) blank(buf, b);
    else if (b.type === "mvhd") clearTimes(buf, b);
    else if (b.type === "trak") {
      const mdia = child(buf, b, "mdia");
      const hdlr = mdia && child(buf, mdia, "hdlr");
      // hdlr：version・flags（4）＋ pre_defined（4）の後に handler_type
      const handler = hdlr ? buf.toString("latin1", hdlr.start + hdlr.header + 8, hdlr.start + hdlr.header + 12) : "";
      if (handler !== "vide" && handler !== "soun") {
        const stbl = mdia && child(buf, mdia, "minf") && child(buf, child(buf, mdia, "minf")!, "stbl");
        if (stbl) blankSamples(buf, stbl);
        blank(buf, b);
        continue;
      }
      for (const t of readBoxes(buf, b.start + b.header, b.end)) {
        if (METADATA.has(t.type)) blank(buf, t);
        else if (t.type === "tkhd") clearTimes(buf, t);
      }
      const mdhd = mdia && child(buf, mdia, "mdhd");
      if (mdhd) clearTimes(buf, mdhd);
      if (mdia) for (const m of readBoxes(buf, mdia.start + mdia.header, mdia.end)) if (METADATA.has(m.type)) blank(buf, m);
    }
  }
  return buf;
}

/**
 * メンションの入力欄で、見せる文字と保存する本文を分ける。
 *
 * 入力欄には `@名前` だけを見せ、どこがメンションかは「範囲（span）」として別に持つ。
 * 送信するときに範囲の部分だけを保存用の記法（`@[名前](u:ID)`、編集画面の目印 `@[メンバー](h:0)`）に戻す。
 * 範囲の中を書き換えたら、そのメンションはただの文字になる（別人を指すことはない）。
 */
import { MENTION_RE } from "./richtext";

/** 入力欄の文字の start〜end が、保存用の記法 raw にあたる */
export type MentionSpan = { start: number; end: number; raw: string };

const TOKEN_RE = new RegExp(`${MENTION_RE.source}|@\\[メンバー\\]\\(h:\\d{1,2}\\)`, "g");

/** 保存用の記法を、入力欄に見せる `@名前` にする */
export const labelOf = (raw: string) => `@${raw.slice(2, raw.indexOf("]("))}`;

export const hasTokens = (text: string) => new RegExp(TOKEN_RE.source).test(text);

/** 保存用の本文 → 入力欄の文字と範囲 */
export function decode(raw: string): { text: string; spans: MentionSpan[] } {
  let text = "";
  let last = 0;
  const spans: MentionSpan[] = [];
  for (const m of raw.matchAll(TOKEN_RE)) {
    text += raw.slice(last, m.index);
    const label = labelOf(m[0]);
    spans.push({ start: text.length, end: text.length + label.length, raw: m[0] });
    text += label;
    last = m.index! + m[0].length;
  }
  return { text: text + raw.slice(last), spans };
}

/** 入力欄の文字と範囲 → 保存用の本文。範囲の文字が書き換わっていれば、記法には戻さない */
export function encode(text: string, spans: MentionSpan[]): string {
  let out = "";
  let last = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < last || text.slice(s.start, s.end) !== labelOf(s.raw)) continue;
    out += text.slice(last, s.start) + s.raw;
    last = s.end;
  }
  return out + text.slice(last);
}

/**
 * 入力（打鍵・貼り付け・削除・変換）の前後の文字から、範囲を付け直す。
 * 変わった場所はカーソル位置（caret：入力後の選択の終わり）で終わるとみなし、
 * そこより前の範囲はそのまま、後ろの範囲はずらし、重なった範囲は捨てる。
 */
export function applyEdit(prev: string, next: string, caret: number, spans: MentionSpan[]): MentionSpan[] {
  let suffix = 0;
  const suffixMax = Math.min(prev.length, next.length - Math.min(caret, next.length));
  while (suffix < suffixMax && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  let prefix = 0;
  const prefixMax = Math.min(prev.length, next.length) - suffix;
  while (prefix < prefixMax && prev[prefix] === next[prefix]) prefix++;
  return shift(spans, prefix, prev.length - suffix, next.length - prev.length);
}

/** from〜to を insert に置き換える。raw を渡すと、入れた文字の先頭をメンションの範囲にする */
export function replaceRange(text: string, spans: MentionSpan[], from: number, to: number, insert: string, raw?: string) {
  const next = shift(spans, from, to, insert.length - (to - from));
  if (raw) next.push({ start: from, end: from + labelOf(raw).length, raw });
  return { text: text.slice(0, from) + insert + text.slice(to), spans: next.sort((a, b) => a.start - b.start), caret: from + insert.length };
}

function shift(spans: MentionSpan[], from: number, to: number, delta: number): MentionSpan[] {
  return spans.flatMap((s) => (s.end <= from ? [s] : s.start >= to ? [{ ...s, start: s.start + delta, end: s.end + delta }] : []));
}

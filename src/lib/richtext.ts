/**
 * 本文の中のメンションとハッシュタグ（F-12）。サーバーと画面の両方で使うので、依存を持たない。
 *
 * メンションは `@[表示名](u:会員ID)` の形で本文に保存する（入力欄で候補から選ぶと入る）。
 * 表示名の部分は書いた時点の目安で、表示するときは会員 ID から現在の名前を引き直す
 * （名前を偽って別人になりすますことはできない）。
 */
export const MENTION_RE = /@\[([^\]\n]{1,40})\]\(u:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/g;
/** 行頭・空白・括弧の直後の #タグ（文字・数字・_・長音、1〜30 文字） */
const HASHTAG_RE = /(^|[\s　(（「『【])#([\p{L}\p{N}_ー]{1,30})/gu;

export const MAX_MENTIONS = 10;
export const MAX_TAGS = 10;

export type RichToken = { type: "text"; text: string } | { type: "mention"; id: string; name: string } | { type: "tag"; tag: string };

export const mentionToken = (name: string, id: string) => `@[${name.replace(/[[\]\n]/g, "").slice(0, 40)}](u:${id})`;

/** 検索・保存用にタグをそろえる（全角半角・大文字小文字の違いを吸収） */
export const normalizeTag = (tag: string) => tag.normalize("NFKC").toLowerCase();

export function extractMentionIds(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION_RE)].map((m) => m[2]!))].slice(0, MAX_MENTIONS);
}

export function extractTags(body: string): string[] {
  // メンションの中の # は拾わない
  const plain = body.replace(MENTION_RE, " ");
  return [...new Set([...plain.matchAll(HASHTAG_RE)].map((m) => normalizeTag(m[2]!)))].slice(0, MAX_TAGS);
}

/** 本文を、ふつうの文字・メンション・ハッシュタグの並びに分ける */
export function tokenize(body: string): RichToken[] {
  const out: RichToken[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    let last = 0;
    for (const m of text.matchAll(HASHTAG_RE)) {
      const start = m.index! + m[1]!.length;
      if (start > last) out.push({ type: "text", text: text.slice(last, start) });
      out.push({ type: "tag", tag: m[2]! });
      last = start + 1 + m[2]!.length;
    }
    if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  };
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    pushText(body.slice(last, m.index));
    out.push({ type: "mention", id: m[2]!, name: m[1]! });
    last = m.index! + m[0].length;
  }
  pushText(body.slice(last));
  return out;
}

/**
 * 表示用に、メンションの名前を現在の名前に置き換える。見えない相手（ブロック関係・停止・退会）は
 * 「@メンバー」というただの文字にする（名前も ID も画面に出さない）。
 */
export function resolveMentions(body: string, names: Map<string, string | null>): string {
  return body.replace(MENTION_RE, (_all, _name, id: string) => {
    const name = names.get(id);
    return name ? mentionToken(name, id) : "@メンバー";
  });
}

/** 編集画面用の目印。MENTION_RE には当たらないので、表示やメンションの抽出には使われない */
const HIDDEN_RE = /@\[メンバー\]\(h:(\d{1,2})\)/g;

/**
 * 編集画面に渡す本文。いま見えない相手へのメンションは、名前も ID も出さずに
 * 番号付きの目印（@[メンバー](h:0)）にする。保存時に unmaskHiddenMentions で元に戻す。
 */
export function maskHiddenMentions(body: string, names: Map<string, string | null>): string {
  let i = 0;
  return body.replace(MENTION_RE, (_all, _name, id: string) => {
    const name = names.get(id);
    return name ? mentionToken(name, id) : `@[メンバー](h:${i++})`;
  });
}

/** 編集後の本文の目印を、保存済みの本文にあった元のメンションに戻す（残された目印の分だけ） */
export function unmaskHiddenMentions(edited: string, stored: string, names: Map<string, string | null>): string {
  const hidden = [...stored.matchAll(MENTION_RE)].filter((m) => !names.get(m[2]!)).map((m) => m[0]);
  return edited.replace(HIDDEN_RE, (all, n: string) => hidden[Number(n)] ?? "@メンバー");
}

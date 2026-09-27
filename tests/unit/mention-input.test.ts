import { describe, expect, it } from "vitest";
import { applyEdit, decode, encode, replaceRange, type MentionSpan } from "@/lib/mention-input";
import { mentionToken } from "@/lib/richtext";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

/** 入力欄で 1 回の編集をしたときの、送られる本文 */
function edit(raw: string, change: (text: string) => { next: string; caret: number }) {
  const d = decode(raw);
  const { next, caret } = change(d.text);
  return encode(next, applyEdit(d.text, next, caret, d.spans));
}

describe("メンションの入力欄：見せる文字と送る本文", () => {
  it("保存用の記法は @名前 だけ見せ、そのまま戻すと元の本文になる", () => {
    const raw = `${mentionToken("佐藤 健", A)} さんと ${mentionToken("田中", B)}、編集中の @[メンバー](h:0) も`;
    const d = decode(raw);
    expect(d.text).toBe("@佐藤 健 さんと @田中、編集中の @メンバー も");
    expect(encode(d.text, d.spans)).toBe(raw);
  });

  it("メンションの前後に書き足しても、メンションは残る", () => {
    const raw = `${mentionToken("田中", A)}`;
    expect(edit(raw, (t) => ({ next: `こんにちは ${t}`, caret: 6 }))).toBe(`こんにちは ${raw}`);
    // 直後に続けて書いた文字は、メンションの外になる
    expect(edit(raw, (t) => ({ next: `${t}さん`, caret: t.length + 2 }))).toBe(`${raw}さん`);
    // 直前に @ を打っても、カーソル位置から、書き足したのは先頭だと判断する
    expect(edit(raw, (t) => ({ next: `@${t}`, caret: 1 }))).toBe(`@${raw}`);
  });

  it("メンションの中を書き換えたら、ただの文字になる（別人を指さない）", () => {
    const raw = `${mentionToken("田中", A)} です`;
    expect(edit(raw, (t) => ({ next: t.replace("田中", "田X中"), caret: 3 }))).toBe("@田X中 です");
    expect(edit(raw, (t) => ({ next: t.slice(0, 2) + t.slice(3), caret: 2 }))).toBe("@田 です");
  });

  it("同じ名前の別人も、書いた位置で取り違えない", () => {
    const raw = `${mentionToken("田中", A)} と ${mentionToken("田中", B)}`;
    // 1 人目を消すと、残るのは 2 人目（B）
    const d = decode(raw);
    const r = replaceRange(d.text, d.spans, d.spans[0]!.start, d.spans[0]!.end, "");
    expect(encode(r.text, r.spans)).toBe(` と ${mentionToken("田中", B)}`);
  });

  it("候補を選ぶと、@検索語 を @名前 に置き換えて範囲を付ける", () => {
    const text = "やあ @さと";
    const raw = mentionToken("佐藤", A);
    const r = replaceRange(text, [], 3, text.length, "@佐藤 ", raw);
    expect(r.text).toBe("やあ @佐藤 ");
    expect(r.caret).toBe(r.text.length);
    expect(encode(r.text, r.spans)).toBe(`やあ ${raw} `);
  });

  it("範囲と文字が食い違っていたら、記法には戻さない（手で書いた記法はそのまま送る）", () => {
    const spans: MentionSpan[] = [{ start: 0, end: 3, raw: mentionToken("田中", A) }];
    expect(encode("@佐藤", spans)).toBe("@佐藤");
    const typed = `${mentionToken("自分で書いた", B)}`;
    expect(encode(typed, [])).toBe(typed);
  });
});

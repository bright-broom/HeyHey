import { describe, expect, it } from "vitest";
import { extractMentionIds, extractTags, mentionToken, resolveMentions, tokenize } from "@/lib/richtext";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("メンションとハッシュタグの読み取り", () => {
  it("メンションは会員 ID で拾い、重複はまとめる", () => {
    const body = `${mentionToken("佐藤 健", A)} と ${mentionToken("田中", B)}、もう一度 ${mentionToken("佐藤", A)}`;
    expect(extractMentionIds(body)).toEqual([A, B]);
    expect(extractMentionIds("@佐藤 さん")).toEqual([]);
    expect(extractMentionIds("@[x](u:not-a-uuid)")).toEqual([]);
  });

  it("ハッシュタグは行頭・空白・括弧の後だけ拾い、表記ゆれをそろえる", () => {
    expect(extractTags("#写真 と #Kakomi と （#旅行） 、a#not と #ＴＥＳＴ")).toEqual(["写真", "kakomi", "旅行", "test"]);
    expect(extractTags(`${mentionToken("#偽タグ", A)}`)).toEqual([]);
  });

  it("本文を文字・メンション・タグの並びに分ける", () => {
    const body = `こんにちは ${mentionToken("佐藤", A)}\n#写真 を撮った`;
    expect(tokenize(body)).toEqual([
      { type: "text", text: "こんにちは " },
      { type: "mention", id: A, name: "佐藤" },
      { type: "text", text: "\n" },
      { type: "tag", tag: "写真" },
      { type: "text", text: " を撮った" },
    ]);
  });

  it("表示前に名前を引き直し、見えない相手は名前も ID も消して「@メンバー」にする", () => {
    const body = `${mentionToken("偽の名前", A)} ${mentionToken("ブロック相手", B)}`;
    const out = resolveMentions(body, new Map([[A, "本当の名前"], [B, null]]));
    expect(out).toBe(`${mentionToken("本当の名前", A)} @メンバー`);
    expect(out).not.toContain(B);
    expect(out).not.toContain("ブロック相手");
  });
});

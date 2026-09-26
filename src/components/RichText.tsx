import Link from "next/link";
import { tokenize } from "@/lib/richtext";

/**
 * 本文の表示。メンションはプロフィールへ、ハッシュタグはタグの一覧へリンクする。
 * 本文はサーバー側で名前を引き直し済み（見えない相手は「@メンバー」のただの文字）。
 */
export function RichText({ body, className }: { body: string; className?: string }) {
  return (
    <p className={className}>
      {tokenize(body).map((t, i) =>
        t.type === "mention" ? (
          <Link key={i} href={`/u/${t.id}`} className="font-medium underline decoration-line-strong underline-offset-4 hover:decoration-ink">
            @{t.name}
          </Link>
        ) : t.type === "tag" ? (
          <Link key={i} href={`/tags/${encodeURIComponent(t.tag.normalize("NFKC").toLowerCase())}`} className="text-ink-soft underline decoration-line underline-offset-4 hover:decoration-ink">
            #{t.tag}
          </Link>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </p>
  );
}

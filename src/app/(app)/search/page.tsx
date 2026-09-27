import Link from "next/link";
import { PageTitle } from "@/components/PageTitle";
import { PostCard } from "@/components/PostCard";
import { getDb } from "@/server/db/client";
import { listFeed, SEARCH_MAX } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "投稿を検索" };

/**
 * 投稿の全文検索（F-08）。結果もフィードと同じ公開範囲の判定（visiblePost）を通るので、見えない投稿は出ない。
 * 空白で区切ると、すべての語を含む投稿を探す。
 */
export default async function SearchPage(props: PageProps<"/search">) {
  const viewer = await requireMember();
  const sp = await props.searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, SEARCH_MAX);
  const before = typeof sp.before === "string" ? new Date(sp.before) : null;
  const result = q ? await listFeed(await getDb(), viewer, { q, before }) : null;
  return (
    <div className="max-w-2xl">
      <PageTitle plaque="SEARCH" title="投稿を検索" />
      <form role="search" className="mb-10 flex gap-3">
        <input
          name="q"
          defaultValue={q}
          maxLength={SEARCH_MAX}
          placeholder="ことばで探す（空白で区切ると、すべてを含む投稿）"
          className="input flex-1"
          aria-label="検索することば"
        />
        <button className="btn-primary">探す</button>
      </form>
      {result && result.posts.length === 0 && <p className="border-t border-line py-16 text-center text-sm text-muted">「{q}」を含む投稿は見つかりませんでした。</p>}
      {result?.posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
      {result?.nextBefore && (
        <div className="py-10 text-center">
          <Link href={`/search?q=${encodeURIComponent(q)}&before=${encodeURIComponent(result.nextBefore.toISOString())}`} className="btn-ghost">
            さらに読む
          </Link>
        </div>
      )}
    </div>
  );
}

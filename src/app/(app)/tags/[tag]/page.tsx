import Link from "next/link";
import { PageTitle } from "@/components/PageTitle";
import { PostCard } from "@/components/PostCard";
import { normalizeTag } from "@/lib/richtext";
import { getDb } from "@/server/db/client";
import { listFeed } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "ハッシュタグ" };

/** ハッシュタグの付いた投稿。一覧も公開範囲の判定（visiblePost）を通るので、見えない投稿は出ない */
export default async function TagPage(props: PageProps<"/tags/[tag]">) {
  const viewer = await requireMember();
  const tag = normalizeTag(decodeURIComponent((await props.params).tag)).slice(0, 30);
  const sp = await props.searchParams;
  const before = typeof sp.before === "string" ? new Date(sp.before) : null;
  const { posts, nextBefore } = await listFeed(await getDb(), viewer, { tag, before });
  return (
    <div className="max-w-2xl">
      <PageTitle plaque="TAG" title={`#${tag}`} />
      {posts.length === 0 && <p className="border-t border-line py-16 text-center text-sm text-muted">このタグの投稿はまだありません。</p>}
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
      {nextBefore && (
        <div className="py-10 text-center">
          <Link href={`/tags/${encodeURIComponent(tag)}?before=${encodeURIComponent(nextBefore.toISOString())}`} className="btn-ghost">
            さらに読む
          </Link>
        </div>
      )}
    </div>
  );
}

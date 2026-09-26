import Link from "next/link";
import { Composer } from "@/components/Composer";
import { PostCard } from "@/components/PostCard";
import { getDb } from "@/server/db/client";
import { listFeed } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "ホーム" };

export default async function FeedPage(props: PageProps<"/">) {
  const viewer = await requireMember();
  const sp = await props.searchParams;
  const before = typeof sp.before === "string" ? new Date(sp.before) : null;
  const { posts, nextBefore } = await listFeed(await getDb(), viewer, { before });
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      {!before && <Composer name={viewer.displayName} />}
      {posts.length === 0 && (
        <div className="card p-8 text-center text-sm text-muted">
          まだ投稿がありません。最初の投稿をしてみましょう。
        </div>
      )}
      {posts.map((p) => (
        <PostCard key={p.id} post={p} />
      ))}
      {nextBefore && (
        <Link href={`/?before=${encodeURIComponent(nextBefore.toISOString())}`} className="btn-ghost w-full">
          もっと見る
        </Link>
      )}
    </div>
  );
}

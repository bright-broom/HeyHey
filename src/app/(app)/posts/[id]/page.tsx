import { notFound } from "next/navigation";
import { PostCard } from "@/components/PostCard";
import { getDb } from "@/server/db/client";
import { getPost } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "投稿" };

export default async function PostPage(props: PageProps<"/posts/[id]">) {
  const viewer = await requireMember();
  const { id } = await props.params;
  const post = await getPost(await getDb(), viewer, id);
  // 見えない投稿は「存在しない」と同じ扱い（公開範囲の外にあることも明かさない）
  if (!post) notFound();
  return (
    <div className="mx-auto max-w-2xl">
      <PostCard post={post} mode="detail" />
    </div>
  );
}

import { notFound } from "next/navigation";
import { getDb } from "@/server/db/client";
import { getPost } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";
import { EditForm } from "./EditForm";

export const metadata = { title: "投稿を編集" };

export default async function EditPostPage(props: PageProps<"/posts/[id]/edit">) {
  const viewer = await requireMember();
  const { id } = await props.params;
  const post = await getPost(await getDb(), viewer, id);
  if (!post || !post.isMine) notFound();
  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <h1 className="h1">投稿を編集</h1>
      <EditForm id={post.id} body={post.body} visibility={post.visibility} />
    </div>
  );
}

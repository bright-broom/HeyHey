import { PageTitle } from "@/components/PageTitle";
import { notFound } from "next/navigation";
import { getDb } from "@/server/db/client";
import { getPostForEdit } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";
import { EditForm } from "./EditForm";

export const metadata = { title: "投稿を編集" };

export default async function EditPostPage(props: PageProps<"/posts/[id]/edit">) {
  const viewer = await requireMember();
  const { id } = await props.params;
  const post = await getPostForEdit(await getDb(), viewer, id);
  if (!post) notFound();
  return (
    <div className="max-w-[640px]">
      <PageTitle plaque="EDIT" title="投稿を編集" />
      <EditForm id={post.id} body={post.body} visibility={post.visibility} inGroup={post.inGroup} />
    </div>
  );
}

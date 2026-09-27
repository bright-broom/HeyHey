import { PageTitle } from "@/components/PageTitle";
import { requireMember } from "@/server/web/session";
import { GroupForm } from "../GroupForm";

export const metadata = { title: "グループを作る" };

export default async function NewGroupPage() {
  await requireMember();
  return (
    <div className="max-w-xl">
      <PageTitle plaque="NEW GROUP" title="グループを作る" lead="あなたが管理人になります。参加の承認やメンバーの整理は管理人が行います。" />
      <GroupForm />
    </div>
  );
}

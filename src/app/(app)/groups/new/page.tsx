import { PageTitle } from "@/components/PageTitle";
import { requireMember } from "@/server/web/session";
import { GroupForm } from "../GroupForm";

export const metadata = { title: "グループを作る" };

export default async function NewGroupPage() {
  await requireMember();
  return (
    <div className="max-w-xl">
      <PageTitle plaque="NEW GROUP" title="グループを作る" lead="あなたがオーナーになります。モデレーターを任命して、参加の承認を分担できます。" />
      <GroupForm />
    </div>
  );
}

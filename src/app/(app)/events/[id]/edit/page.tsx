import { notFound } from "next/navigation";
import { updateEventAction } from "@/app/actions/events";
import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { getEvent, toJstLocal } from "@/server/services/events";
import { requireMember } from "@/server/web/session";
import { EventForm } from "../../EventForm";

export const metadata = { title: "イベントを編集" };

export default async function EditEventPage(props: PageProps<"/events/[id]/edit">) {
  const viewer = await requireMember();
  const e = await getEvent(await getDb(), viewer, (await props.params).id);
  if (!e || !e.isMine) notFound();
  return (
    <div className="max-w-2xl">
      <PageTitle plaque="EDIT EVENT" title="イベントを編集" />
      <EventForm
        action={updateEventAction}
        eventId={e.id}
        initial={{ title: e.title, description: e.description, location: e.location, startsAt: toJstLocal(e.startsAt), endsAt: e.endsAt ? toJstLocal(e.endsAt) : "" }}
        cancelHref={`/events/${e.id}`}
      />
    </div>
  );
}

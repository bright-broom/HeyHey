import { createEventAction } from "@/app/actions/events";
import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { groupsForEvents, toJstLocal } from "@/server/services/events";
import { requireMember } from "@/server/web/session";
import { EventForm } from "../EventForm";

export const metadata = { title: "イベントを作る" };

export default async function NewEventPage(props: PageProps<"/events/new">) {
  const viewer = await requireMember();
  const groups = await groupsForEvents(await getDb(), viewer);
  const sp = await props.searchParams;
  const groupId = typeof sp.group === "string" && groups.some((g) => g.id === sp.group) ? sp.group : "";
  // 既定は翌日の 19:00（日本時間）
  const tomorrow = toJstLocal(new Date(Date.now() + 24 * 3600_000)).slice(0, 10);
  return (
    <div className="max-w-2xl">
      <PageTitle plaque="NEW EVENT" title="イベントを作る" />
      <EventForm
        action={createEventAction}
        initial={{ title: "", description: "", location: "", startsAt: `${tomorrow}T19:00`, endsAt: "", groupId }}
        groups={groups}
        cancelHref="/events"
      />
    </div>
  );
}

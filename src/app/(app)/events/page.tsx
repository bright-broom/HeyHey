import Link from "next/link";
import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { listEvents } from "@/server/services/events";
import { EventRow } from "./EventRow";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "イベント" };

/** イベントの一覧（F-17）。見える範囲は visibleEvent（全会員向けと、自分が入っているグループのもの） */
export default async function EventsPage(props: PageProps<"/events">) {
  const viewer = await requireMember();
  const past = (await props.searchParams).past === "1";
  const list = await listEvents(await getDb(), viewer, { past });
  return (
    <div className="max-w-3xl">
      <PageTitle plaque="EVENTS" title="イベント" lead="集まりの日時と場所を共有し、出欠を集めます。グループのイベントは、そのグループのメンバーにだけ見えます。" />
      <div className="mb-6 flex items-center justify-between gap-4">
        <nav className="flex gap-5 text-sm" aria-label="イベントの表示">
          <Link href="/events" aria-current={!past ? "page" : undefined} className={!past ? "text-ink underline underline-offset-8" : "text-muted hover:text-ink"}>
            これから
          </Link>
          <Link href="/events?past=1" aria-current={past ? "page" : undefined} className={past ? "text-ink underline underline-offset-8" : "text-muted hover:text-ink"}>
            終わったもの
          </Link>
        </nav>
        <Link href="/events/new" className="btn-primary">
          イベントを作る
        </Link>
      </div>
      {list.length === 0 ? (
        <p className="border-t border-line py-16 text-center text-sm text-muted">{past ? "終わったイベントはありません。" : "予定されているイベントはありません。"}</p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.map((e) => (
            <EventRow key={e.id} e={e} />
          ))}
        </ul>
      )}
    </div>
  );
}

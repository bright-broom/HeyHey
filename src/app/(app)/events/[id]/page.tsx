import Link from "next/link";
import { notFound } from "next/navigation";
import { eventOpAction } from "@/app/actions/events";
import { Avatar } from "@/components/Avatar";
import { PageTitle } from "@/components/PageTitle";
import { getDb } from "@/server/db/client";
import { isAdmin } from "@/server/lib/policy";
import { getEvent, RSVP_LABEL, type RsvpStatus } from "@/server/services/events";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "イベント" };

const fmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });

function Op({ id, op, label, className = "btn-ghost", extra }: { id: string; op: string; label: string; className?: string; extra?: Record<string, string> }) {
  return (
    <form action={eventOpAction}>
      <input type="hidden" name="eventId" value={id} />
      <input type="hidden" name="op" value={op} />
      {extra && Object.entries(extra).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button className={className}>{label}</button>
    </form>
  );
}

/** イベントの詳細と出欠（F-17）。見えないイベントは 404 */
export default async function EventPage(props: PageProps<"/events/[id]">) {
  const viewer = await requireMember();
  const e = await getEvent(await getDb(), viewer, (await props.params).id);
  if (!e) notFound();
  const over = (e.endsAt ?? e.startsAt) < new Date();
  const going = e.attendees.filter((a) => a.status === "going");
  const maybe = e.attendees.filter((a) => a.status === "maybe");
  return (
    <div className="max-w-2xl">
      <PageTitle plaque={e.group ? `EVENT · ${e.group.name}` : "EVENT"} title={e.title} />
      {(e.canceled || e.hidden) && (
        <p className="mb-6 border-l-2 border-danger py-1 pl-3 text-sm text-danger">
          {e.canceled ? "このイベントは中止になりました。" : "管理者により非表示になっています（作った人にだけ見えます）。"}
        </p>
      )}
      <dl className="grid grid-cols-[5rem_1fr] gap-y-3 border-y border-line py-6 text-sm">
        <dt className="text-muted">日時</dt>
        <dd>
          {fmt.format(e.startsAt)}
          {e.endsAt && ` 〜 ${fmt.format(e.endsAt)}`}
        </dd>
        {e.location && (
          <>
            <dt className="text-muted">場所</dt>
            <dd className="break-words">{e.location}</dd>
          </>
        )}
        <dt className="text-muted">見える人</dt>
        <dd>{e.group ? <Link href={`/groups/${e.group.id}`} className="btn-link">グループ「{e.group.name}」のメンバー</Link> : "全会員"}</dd>
        <dt className="text-muted">作った人</dt>
        <dd>{e.creator.id ? <Link href={`/u/${e.creator.id}`} className="btn-link">{e.creator.displayName}</Link> : e.creator.displayName}</dd>
      </dl>
      {e.description && <p className="mt-6 whitespace-pre-wrap break-words leading-[1.95]">{e.description}</p>}

      {!e.canceled && !over && (
        <section className="mt-10" aria-labelledby="rsvp-title">
          <h2 id="rsvp-title" className="h2">出欠</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {(Object.keys(RSVP_LABEL) as RsvpStatus[]).map((s) => (
              <Op key={s} id={e.id} op="rsvp" extra={{ status: s }} label={RSVP_LABEL[s]} className={e.myRsvp === s ? "btn-primary" : "btn-ghost"} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-10" aria-labelledby="people-title">
        <h2 id="people-title" className="h2">
          参加 {going.length}
          {maybe.length > 0 && <span className="ml-3 text-sm font-normal text-muted">未定 {maybe.length}</span>}
        </h2>
        <ul className="mt-4 flex flex-wrap gap-4">
          {[...going, ...maybe].map((a) => (
            <li key={a.id}>
              <Link href={`/u/${a.id}`} className="flex items-center gap-2 text-sm hover:underline hover:underline-offset-4" data-testid="attendee">
                <Avatar name={a.displayName} mediaId={a.avatarMediaId} size={28} />
                {a.displayName}
                {a.status === "maybe" && <span className="text-xs text-muted">（未定）</span>}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {e.isMine && (
        <section className="mt-12 flex flex-wrap gap-2 border-t border-line pt-6">
          <Link href={`/events/${e.id}/edit`} className="btn-ghost">
            編集
          </Link>
          {e.canceled ? <Op id={e.id} op="reopen" label="中止を取り消す" /> : !over && <Op id={e.id} op="cancel" label="中止にする" />}
          <Op id={e.id} op="delete" label="削除" className="btn-link text-danger" />
        </section>
      )}
      {isAdmin(viewer) && !e.isMine && (
        <details className="mt-12 border-t border-line pt-6 text-sm">
          <summary className="cursor-pointer text-muted">管理者の操作</summary>
          {e.hidden ? (
            <div className="mt-3"><Op id={e.id} op="unhide" label="再表示する" /></div>
          ) : (
            <form action={eventOpAction} className="mt-3 flex gap-2">
              <input type="hidden" name="eventId" value={e.id} />
              <input type="hidden" name="op" value="hide" />
              <input name="reason" required placeholder="非表示にする理由（監査ログに残ります）" className="input flex-1" aria-label="非表示にする理由" />
              <button className="btn-danger">非表示にする</button>
            </form>
          )}
        </details>
      )}
    </div>
  );
}

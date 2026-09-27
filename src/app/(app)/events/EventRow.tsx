import Link from "next/link";
import { RSVP_LABEL, type EventSummary } from "@/server/services/events";

const dayFmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" });
const timeFmt = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" });

/** 一覧の 1 行：日付・タイトル・場所・参加人数・自分の出欠 */
export function EventRow({ e }: { e: EventSummary }) {
  return (
    <li>
      <Link href={`/events/${e.id}`} className="grid grid-cols-[5.5rem_1fr_auto] items-baseline gap-4 py-5 transition-opacity hover:opacity-70" data-testid="event">
        <span className="text-sm tabular-nums">
          {dayFmt.format(e.startsAt)}
          <span className="block text-xs text-muted">{timeFmt.format(e.startsAt)}</span>
        </span>
        <span className="min-w-0">
          <span className={`block truncate font-medium ${e.canceled ? "text-muted line-through" : ""}`}>{e.title}</span>
          <span className="block truncate text-xs text-muted">
            {[e.canceled && "中止", e.hidden && "非表示中", e.group && `グループ「${e.group.name}」`, e.location].filter(Boolean).join(" ・ ")}
          </span>
        </span>
        <span className="text-right text-xs text-muted">
          参加 {e.going}
          {e.myRsvp && <span className="block text-ink">あなた：{RSVP_LABEL[e.myRsvp]}</span>}
        </span>
      </Link>
    </li>
  );
}


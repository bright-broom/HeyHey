import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteMessageAction } from "@/app/actions/messages";
import { Avatar } from "@/components/Avatar";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { openConversation } from "@/server/services/messages";
import { requireMember } from "@/server/web/session";
import { AutoRefresh } from "./AutoRefresh";
import { MessageForm } from "./MessageForm";

export const metadata = { title: "メッセージ" };

/**
 * 相手とのやりとり（F-16）。開くと既読になる。相手がブロック関係・停止中・会員でなければ 404。
 * 開いている間は 15 秒ごとに新しいメッセージを取りに行く。
 */
export default async function ConversationPage(props: PageProps<"/messages/[userId]">) {
  const viewer = await requireMember();
  const { userId } = await props.params;
  const sp = await props.searchParams;
  const before = typeof sp.before === "string" ? new Date(sp.before) : null;
  const convo = await openConversation(await getDb(), viewer, userId, { before });
  if (!convo) notFound();
  const { partner } = convo;
  return (
    <div className="max-w-2xl">
      <div className="mb-8 flex items-center gap-4 border-b border-line pb-6">
        <Link href="/messages" className="text-xs tracking-[0.08em] text-muted hover:text-ink">
          ← 一覧
        </Link>
        <Avatar name={partner.displayName} mediaId={partner.avatarMediaId} />
        <h1 className="h2 min-w-0 flex-1 truncate">
          {partner.withdrawn ? partner.displayName : <Link href={`/u/${partner.id}`} className="hover:underline hover:underline-offset-4">{partner.displayName}</Link>}
        </h1>
      </div>
      {convo.olderBefore && (
        <p className="mb-6 text-center">
          <Link href={`/messages/${partner.id}?before=${encodeURIComponent(convo.olderBefore.toISOString())}`} className="btn-ghost">
            前のメッセージ
          </Link>
        </p>
      )}
      {convo.messages.length === 0 && <p className="py-12 text-center text-sm text-muted">まだメッセージはありません。</p>}
      <ol className="space-y-4" aria-label="メッセージ">
        {convo.messages.map((m) => (
          <li key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`} data-testid="message" data-mine={m.mine}>
            <div className={`group max-w-[80%] ${m.mine ? "text-right" : ""}`}>
              <p className={`inline-block whitespace-pre-wrap break-words px-4 py-2.5 text-left text-[15px] leading-relaxed ${m.deleted ? "border border-line text-muted" : m.mine ? "bg-ink text-light" : "border border-line bg-light"}`}>
                {m.deleted ? "削除されたメッセージ" : m.body}
              </p>
              <p className="mt-1 flex items-center gap-3 text-[11px] text-muted" style={{ justifyContent: m.mine ? "flex-end" : "flex-start" }}>
                <time dateTime={m.createdAt.toISOString()}>{formatDateTime(m.createdAt)}</time>
                {m.mine && !m.deleted && (
                  <form action={deleteMessageAction}>
                    <input type="hidden" name="messageId" value={m.id} />
                    <button className="hover:text-danger">消す</button>
                  </form>
                )}
              </p>
            </div>
          </li>
        ))}
      </ol>
      <div className="mt-10">
        {partner.canReceive ? (
          <MessageForm to={partner.id} />
        ) : (
          <p className="border-t border-line pt-6 text-sm text-muted">{partner.withdrawn ? "退会したメンバーには送れません。" : "この相手には、いまは送れません。"}</p>
        )}
      </div>
      {!before && <AutoRefresh seconds={15} />}
    </div>
  );
}

import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { PageTitle } from "@/components/PageTitle";
import { timeAgo } from "@/components/time";
import { getDb } from "@/server/db/client";
import { listConversations } from "@/server/services/messages";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "メッセージ" };

/** 1 対 1 のやりとりの一覧（F-16）。新しいメッセージの届いた順 */
export default async function MessagesPage() {
  const viewer = await requireMember();
  const list = await listConversations(await getDb(), viewer);
  return (
    <div className="max-w-3xl">
      <PageTitle plaque="MESSAGES" title="メッセージ" lead="やりとりは、あなたと相手の 2 人にだけ見えます（管理者にも見えません）。新しく始めるときは、相手のプロフィールから。" />
      {list.length === 0 ? (
        <p className="border-t border-line py-16 text-center text-sm text-muted">
          まだやりとりはありません。<Link href="/members" className="btn-link">メンバー</Link>のプロフィールから送れます。
        </p>
      ) : (
        <ul className="divide-y divide-line border-y border-line">
          {list.map((c) => (
            <li key={c.partner.id}>
              <Link href={`/messages/${c.partner.id}`} className="flex items-center gap-4 py-4 transition-opacity hover:opacity-70" data-testid="conversation">
                <Avatar name={c.partner.displayName} mediaId={c.partner.avatarMediaId} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate ${c.unread ? "font-medium" : ""}`}>{c.partner.displayName}</p>
                  <p className="truncate text-xs text-muted">
                    {c.lastMessage ? `${c.lastMessage.mine ? "あなた：" : ""}${c.lastMessage.body}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  {c.lastMessage && <p className="text-xs text-muted">{timeAgo(c.lastMessage.createdAt)}</p>}
                  {c.unread > 0 && (
                    <span className="mt-1 inline-block min-w-4 bg-ink px-1 text-center text-[10px] leading-4 tabular-nums text-light">
                      <span className="sr-only">未読 </span>
                      {c.unread}
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

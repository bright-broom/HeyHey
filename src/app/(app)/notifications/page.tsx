import Link from "next/link";
import { markAllReadAction } from "@/app/actions/social";
import { timeAgo } from "@/components/time";
import { getDb } from "@/server/db/client";
import { isAdmin } from "@/server/lib/policy";
import { listNotifications } from "@/server/services/notifications";
import { REACTIONS } from "@/server/services/posts";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "通知" };

type N = Awaited<ReturnType<typeof listNotifications>>[number];

function describe(n: N): { text: string; href?: string } {
  const who = n.actorStatus === "withdrawn" ? "退会したメンバー" : (n.actorName ?? "メンバー");
  const d = n.data as Record<string, string>;
  switch (n.type) {
    case "comment":
      return { text: `${who} さんがあなたの投稿にコメントしました`, href: `/posts/${n.postId}` };
    case "reply":
      return { text: `${who} さんがあなたのコメントに返信しました`, href: `/posts/${n.postId}` };
    case "reaction":
      return { text: `${who} さんがあなたの投稿に「${REACTIONS[d.reaction as keyof typeof REACTIONS] ?? "リアクション"}」しました`, href: `/posts/${n.postId}` };
    case "friend_request":
      return { text: `${who} さんから友達申請が届きました`, href: "/friends" };
    case "friend_accepted":
      return { text: `${who} さんが友達申請を承認しました`, href: `/u/${n.actorId}` };
    case "report_resolved":
      return { text: `あなたの通報が処理されました（${d.resolution}）` };
    case "moderation":
      return { text: `あなたの${d.targetType === "comment" ? "コメント" : "投稿"}に対して管理者が対応しました（${d.resolution}）${d.note ? `：${d.note}` : ""}` };
    case "application_submitted":
      return { text: `新しい入会申請が届きました（${d.name ?? ""}）`, href: "/admin/applications" };
    case "report_submitted":
      return { text: "新しい通報が届きました", href: "/admin/reports" };
    default:
      return { text: "お知らせがあります" };
  }
}

export default async function NotificationsPage() {
  const viewer = await requireMember();
  const items = await listNotifications(await getDb(), viewer);
  const admin = isAdmin(viewer);
  const hasUnread = items.some((n) => !n.readAt);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="h1">通知</h1>
        {hasUnread && (
          <form action={markAllReadAction}>
            <button className="btn-ghost py-1.5">すべて既読にする</button>
          </form>
        )}
      </div>
      <ul className="card divide-y divide-line">
        {items
          .filter((n) => admin || !["application_submitted", "report_submitted"].includes(n.type))
          .map((n) => {
            const { text, href } = describe(n);
            const body = (
              <div className="flex items-start gap-3 p-3">
                <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? "bg-transparent" : "bg-brand"}`} aria-label={n.readAt ? undefined : "未読"} />
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${n.readAt ? "text-muted" : "font-medium"}`}>{text}</p>
                  <p className="text-xs text-muted">{timeAgo(n.createdAt)}</p>
                </div>
              </div>
            );
            return <li key={n.id}>{href ? <Link href={href} className="block hover:bg-canvas">{body}</Link> : body}</li>;
          })}
        {items.length === 0 && <li className="p-6 text-center text-sm text-muted">通知はありません。</li>}
      </ul>
    </div>
  );
}

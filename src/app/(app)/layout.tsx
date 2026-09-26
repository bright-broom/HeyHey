import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { Avatar } from "@/components/Avatar";
import { FlashToast } from "@/components/Flash";
import { getDb } from "@/server/db/client";
import { isAdmin } from "@/server/lib/policy";
import { unreadCount } from "@/server/services/notifications";
import { profiles } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import { readFlash } from "@/server/web/flash";
import { requireMember } from "@/server/web/session";

/** 会員エリアの入口。ここを通らないと、配下のどのページも描画されない */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireMember();
  const db = await getDb();
  const [unread, [profile]] = await Promise.all([
    unreadCount(db, viewer),
    db.select({ avatarMediaId: profiles.avatarMediaId }).from(profiles).where(eq(profiles.userId, viewer.id)),
  ]);
  const nav = [
    { href: "/", label: "ホーム" },
    { href: "/members", label: "メンバー" },
    { href: "/friends", label: "友達" },
    { href: "/notifications", label: "通知", badge: unread },
    { href: "/invites", label: "招待" },
  ];
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-2.5">
          <Link href="/" className="text-lg font-extrabold tracking-tight text-brand">
            Kakomi
          </Link>
          <form action="/members" className="hidden flex-1 sm:block">
            <input name="q" placeholder="メンバーを検索" className="input max-w-xs py-1.5 text-sm" aria-label="メンバーを検索" />
          </form>
          <div className="ml-auto flex items-center gap-2">
            {isAdmin(viewer) && (
              <Link href="/admin" className="badge bg-ink text-white">
                管理
              </Link>
            )}
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full p-0.5 hover:bg-canvas" aria-label="アカウントメニュー">
                <Avatar name={viewer.displayName} mediaId={profile?.avatarMediaId} size={32} />
              </summary>
              <div className="absolute right-0 mt-2 w-48 rounded-lg border border-line bg-card p-1 text-sm shadow-lg">
                <Link href={`/u/${viewer.id}`} className="block rounded px-3 py-2 hover:bg-canvas">プロフィール</Link>
                <Link href="/settings" className="block rounded px-3 py-2 hover:bg-canvas">設定</Link>
                <form action={logoutAction}>
                  <button className="w-full rounded px-3 py-2 text-left hover:bg-canvas">ログアウト</button>
                </form>
              </div>
            </details>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-2 pb-1" aria-label="メインメニュー">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="relative whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium text-muted hover:bg-canvas hover:text-ink">
              {n.label}
              {n.badge ? (
                <span className="ml-1 rounded-full bg-danger px-1.5 text-[11px] font-bold text-white" data-testid="unread">
                  {n.badge > 99 ? "99+" : n.badge}
                </span>
              ) : null}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      <FlashToast flash={await readFlash()} />
    </div>
  );
}

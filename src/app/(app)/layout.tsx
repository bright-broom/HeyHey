import Link from "next/link";
import { eq } from "drizzle-orm";
import { logoutAction } from "@/app/actions/auth";
import { Avatar } from "@/components/Avatar";
import { FlashToast } from "@/components/Flash";
import { NavLinks } from "@/components/NavLinks";
import { getDb } from "@/server/db/client";
import { profiles } from "@/server/db/schema";
import { hasAdminRole } from "@/server/lib/policy";
import { unreadCount } from "@/server/services/notifications";
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
      <header className="sticky top-0 z-20 border-b border-line bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-10 px-5 sm:px-8">
          <Link href="/" className="py-5 text-[12px] font-medium tracking-[0.42em]">
            KAKOMI
          </Link>
          <div className="hidden md:block">
            <NavLinks items={nav} label="メインメニュー" />
          </div>
          <div className="ml-auto flex items-center gap-5">
            <form action="/members" className="hidden lg:block" role="search">
              <input
                name="q"
                placeholder="メンバーを探す"
                className="w-44 border-0 border-b border-line-strong bg-transparent px-0 py-1.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-ink"
                aria-label="メンバーを検索"
              />
            </form>
            {hasAdminRole(viewer) && (
              <Link href="/admin" className="plaque hover:text-ink">
                ADMIN
              </Link>
            )}
            <details className="relative">
              <summary className="flex cursor-pointer list-none items-center rounded-full" aria-label="アカウントメニュー">
                <Avatar name={viewer.displayName} mediaId={profile?.avatarMediaId} size={32} />
              </summary>
              <div className="fade-in absolute right-0 mt-3 w-52 border border-line bg-light py-2 text-sm shadow-lg">
                <p className="truncate px-4 pb-2 pt-1 text-xs text-muted">{viewer.displayName}</p>
                <div className="rule" />
                <Link href={`/u/${viewer.id}`} className="block px-4 py-2.5 hover:bg-canvas">プロフィール</Link>
                <Link href="/settings" className="block px-4 py-2.5 hover:bg-canvas">設定</Link>
                <form action={logoutAction}>
                  <button className="w-full px-4 py-2.5 text-left text-muted hover:bg-canvas hover:text-ink">ログアウト</button>
                </form>
              </div>
            </details>
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-5 sm:px-8 md:hidden">
          <NavLinks items={nav} label="メインメニュー" />
        </div>
      </header>
      {hasAdminRole(viewer) && !viewer.mfa && (
        <div className="border-b border-line bg-light">
          <p className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-sm sm:px-8">
            <span>管理機能を使うには、2 段階認証の設定が必要です。</span>
            <Link href="/settings/security" className="btn-link">
              設定する
            </Link>
          </p>
        </div>
      )}
      <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 lg:py-14">{children}</main>
      <FlashToast flash={await readFlash()} />
    </div>
  );
}

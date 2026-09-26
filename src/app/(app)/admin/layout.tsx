import Link from "next/link";
import { requireAdmin } from "@/server/web/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireAdmin();
  const tabs = [
    { href: "/admin", label: "ダッシュボード" },
    { href: "/admin/applications", label: "入会審査" },
    { href: "/admin/members", label: "会員管理" },
    { href: "/admin/reports", label: "通報" },
    { href: "/admin/audit", label: "監査ログ" },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge bg-ink text-white">{viewer.role === "owner" ? "オーナー" : "管理者"}</span>
        <nav className="flex flex-wrap gap-1" aria-label="管理メニュー">
          {tabs.map((t) => (
            <Link key={t.href} href={t.href} className="rounded-md px-3 py-1.5 text-sm font-medium text-muted hover:bg-card hover:text-ink">
              {t.label}
            </Link>
          ))}
        </nav>
      </div>
      {children}
    </div>
  );
}

import { NavLinks } from "@/components/NavLinks";
import { requireAdmin } from "@/server/web/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const viewer = await requireAdmin();
  const tabs = [
    { href: "/admin", label: "ダッシュボード", exact: true },
    { href: "/admin/applications", label: "入会審査" },
    { href: "/admin/members", label: "会員管理" },
    { href: "/admin/reports", label: "通報" },
    { href: "/admin/audit", label: "監査ログ" },
  ];
  return (
    <div>
      <div className="mb-12 flex flex-wrap items-center gap-x-8 border-b border-line">
        <span className="plaque py-4 text-ink">ADMIN</span>
        <NavLinks items={tabs} label="管理メニュー" />
      </div>
      {children}
    </div>
  );
}

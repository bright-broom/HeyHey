"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Item = { href: string; label: string; badge?: number; exact?: boolean };

/** 現在地に 1px の線を引くナビ。数字のバッジは四角い墨の小片 */
export function NavLinks({ items, label }: { items: Item[]; label: string }) {
  const path = usePathname();
  const isActive = (i: Item) =>
    i.exact ? path === i.href : path === i.href || path.startsWith(`${i.href}/`) || (i.href === "/" && path.startsWith("/posts"));
  return (
    <nav aria-label={label} className="-mb-px flex gap-6 overflow-x-auto">
      {items.map((i) => {
        const active = isActive(i);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? "page" : undefined}
            className={`relative whitespace-nowrap py-4 text-[13px] tracking-[0.12em] transition-colors duration-200 ${
              active ? "text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-ink" : "text-muted hover:text-ink"
            }`}
          >
            {i.label}
            {i.badge ? (
              <span className="ml-1.5 inline-block min-w-4 bg-ink px-1 text-center text-[10px] leading-4 tabular-nums text-light" data-testid="unread">
                {i.badge > 99 ? "99+" : i.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

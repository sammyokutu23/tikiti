"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export type NavItem = { href: string; label: string; exact?: boolean };

export function DashNav({ items }: { items: NavItem[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Dashboard" className="scrollbar-none relative -mx-4 flex gap-1.5 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
      {items.map((it) => {
        const active = it.exact ? path === it.href : path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium transition lg:rounded-2xl",
              active ? "bg-primary text-primary-fg" : "bg-fg/6 text-fg/80 hover:bg-fg/12 lg:bg-transparent",
            )}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

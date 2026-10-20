"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Desktop header links; the current section is sun-yellow with an underline bar. */
export function NavLinks({ items }: { items: { href: string; label: string }[] }) {
  const path = usePathname();
  const isActive = (href: string) =>
    href === "/events" ? path === "/" || path.startsWith("/events") : path === href || path.startsWith(`${href}/`);
  return (
    <nav aria-label="Main" className="hidden h-full items-stretch gap-1 text-[15px] md:flex">
      {items.map((it) => {
        const active = isActive(it.href);
        return (
          <Link
            key={it.href}
            href={it.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "relative flex items-center px-3 font-medium transition",
              active ? "text-sun" : "text-fg/85 hover:text-fg",
            )}
          >
            {it.label}
            {active && <span className="absolute inset-x-1 bottom-0 h-0.5 rounded-full bg-sun" aria-hidden />}
          </Link>
        );
      })}
    </nav>
  );
}

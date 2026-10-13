"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, Search, Ticket, User } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { href: "/", label: "Explore", icon: Compass, match: (p: string) => p === "/" },
  { href: "/events", label: "Search", icon: Search, match: (p: string) => p.startsWith("/events") },
  { href: "/account", label: "My tickets", icon: Ticket, match: (p: string) => p.startsWith("/account") || p.startsWith("/bookings") },
  { href: "/account/profile", label: "Profile", icon: User, match: (p: string) => p.startsWith("/account/profile") || p.startsWith("/sign-in") || p.startsWith("/sign-up") },
];

/** Floating pill navigation for phones (reference: home screen bottom bar). */
export function BottomNav() {
  const path = usePathname();
  if (/^\/(organizer|admin|pay|checkout|dev)/.test(path) || /^\/events\/[^/]+/.test(path)) return null;
  const activeIdx = items.findLastIndex((i) => i.match(path));
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 md:hidden">
      <ul className="glass flex items-center gap-1 rounded-full border border-white/10 p-1.5 shadow-2xl shadow-black/60">
        {items.map((it, i) => {
          const active = i === activeIdx;
          return (
            <li key={it.href}>
              <Link
                href={it.href}
                aria-label={it.label}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex size-12 items-center justify-center rounded-full transition",
                  active ? "bg-white text-black" : "text-white/75 hover:text-white",
                )}
              >
                <it.icon className="size-5" aria-hidden />
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

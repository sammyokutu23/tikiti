"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Compass, House, Repeat, Ticket, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spark } from "./doodles";

const side = [
  [
    { href: "/", label: "Home", icon: House, match: (p: string) => p === "/" },
    { href: "/events", label: "Explore", icon: Compass, match: (p: string) => p.startsWith("/events") },
  ],
  [
    { href: "/resale", label: "Resale", icon: Repeat, match: (p: string) => p.startsWith("/resale") },
    { href: "/account/profile", label: "Profile", icon: User, match: (p: string) => p.startsWith("/account/profile") || p.startsWith("/sign-in") || p.startsWith("/sign-up") },
  ],
];

/** Floating phone navigation: labelled tabs around a raised "My tickets" button. */
export function BottomNav() {
  const path = usePathname();
  if (/^\/(organizer|admin|pay|checkout|dev)/.test(path) || /^\/events\/[^/]+/.test(path)) return null;
  const ticketsActive = (path.startsWith("/account") && !path.startsWith("/account/profile")) || path.startsWith("/bookings");
  const tab = (it: (typeof side)[number][number]) => {
    const active = it.match(path);
    return (
      <li key={it.href} className="flex-1">
        <Link
          href={it.href}
          aria-current={active ? "page" : undefined}
          className={cn("flex flex-col items-center gap-1 py-2 text-xs font-medium transition", active ? "text-teal" : "text-fg/70 hover:text-fg")}
        >
          <it.icon className="size-6" strokeWidth={active ? 2.4 : 2} aria-hidden />
          {it.label}
        </Link>
      </li>
    );
  };
  return (
    <nav aria-label="Primary" className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4 md:hidden">
      <ul className="glass-nav flex w-full max-w-md items-center rounded-[2rem] border border-line px-2 shadow-2xl shadow-black/15">
        {side[0].map(tab)}
        <li className="relative -mt-8 flex flex-1 justify-center">
          <Spark className="absolute -right-1 -top-3 size-5 rotate-90 text-teal" />
          <Link
            href="/account"
            aria-label="My tickets"
            aria-current={ticketsActive ? "page" : undefined}
            className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-fg shadow-lg shadow-primary/40 ring-4 ring-bg transition active:scale-95"
          >
            <Ticket className="size-7 -rotate-45" aria-hidden />
          </Link>
        </li>
        {side[1].map(tab)}
      </ul>
    </nav>
  );
}

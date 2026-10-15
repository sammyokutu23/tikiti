import Link from "next/link";
import { CATEGORIES } from "@/server/events/queries";
import { cn } from "@/lib/utils";

export function CategoryChips({ active, base = "/events", extra }: { active?: string; base?: string; extra?: Record<string, string | undefined> }) {
  const qs = (category?: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
    if (category) p.set("category", category);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  const chip = (isActive: boolean) =>
    cn(
      "inline-flex h-11 shrink-0 items-center rounded-full px-5 text-sm font-medium transition",
      isActive ? "bg-primary text-primary-fg" : "bg-fg/7 text-fg/85 hover:bg-fg/12",
    );
  return (
    <nav aria-label="Categories" className="scrollbar-none relative -mx-4 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
      <Link href={qs()} className={chip(!active)} aria-current={!active ? "page" : undefined}>
        All
      </Link>
      {CATEGORIES.map((c) => (
        <Link key={c.value} href={qs(c.value)} className={chip(active === c.value)} aria-current={active === c.value ? "page" : undefined}>
          {c.label}
        </Link>
      ))}
    </nav>
  );
}

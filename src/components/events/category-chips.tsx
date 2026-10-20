import Link from "next/link";
import { LayoutGrid } from "lucide-react";
import { CATEGORIES } from "@/server/events/queries";
import { cn } from "@/lib/utils";
import { CATEGORY_STYLE, CHIP_TONE } from "./category-style";

export function CategoryChips({ active, base = "/events", extra }: { active?: string; base?: string; extra?: Record<string, string | undefined> }) {
  const qs = (category?: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
    if (category) p.set("category", category);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  // Selected chip is ink-dark with a mint icon; the rest keep their category colour.
  const chip = (isActive: boolean, tone: string) =>
    cn(
      "inline-flex h-12 shrink-0 items-center gap-2 rounded-full px-5 text-[15px] font-semibold transition hover:brightness-95",
      isActive ? "bg-[#14171a] text-white ring-1 ring-white/15" : tone,
    );
  return (
    <nav aria-label="Categories" className="scrollbar-none relative -mx-4 flex gap-2.5 overflow-x-auto px-4 py-1 sm:mx-0 sm:flex-wrap sm:px-0">
      <Link href={qs()} className={chip(!active, CHIP_TONE.plain)} aria-current={!active ? "page" : undefined}>
        <LayoutGrid className={cn("size-[18px]", !active ? "text-mint" : "")} aria-hidden />
        All
      </Link>
      {CATEGORIES.map((c) => {
        const isActive = active === c.value;
        const { icon: Icon, tone } = CATEGORY_STYLE[c.value];
        return (
          <Link key={c.value} href={qs(c.value)} className={chip(isActive, CHIP_TONE[tone])} aria-current={isActive ? "page" : undefined}>
            <Icon className={cn("size-[18px]", isActive && "text-mint")} aria-hidden />
            {c.label}
          </Link>
        );
      })}
    </nav>
  );
}

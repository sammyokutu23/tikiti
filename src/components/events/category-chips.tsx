import Link from "next/link";
import { LayoutGrid } from "lucide-react";
import { CATEGORIES } from "@/server/events/queries";
import { cn } from "@/lib/utils";
import { CATEGORY_STYLE, CHIP_TONE } from "./category-style";

export function CategoryChips({ active, base = "/", extra }: { active?: string; base?: string; extra?: Record<string, string | undefined> }) {
  const qs = (category?: string) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
    if (category) p.set("category", category);
    const s = p.toString();
    return s ? `${base}?${s}` : base;
  };
  // Selected chip is solid sun-yellow; the rest are dark glass with a coloured icon.
  const chip = (isActive: boolean) =>
    cn(
      "inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[15px] font-medium transition",
      isActive
        ? "bg-sun text-[#1d1300] shadow-lg shadow-sun/25"
        : "border border-line-strong bg-surface/60 text-fg backdrop-blur-md hover:border-sun/50 hover:bg-surface",
    );
  return (
    <nav aria-label="Categories" className="scrollbar-none relative -mx-4 flex gap-2.5 overflow-x-auto px-4 py-1 sm:mx-0 sm:flex-wrap sm:px-0">
      <Link href={qs()} className={chip(!active)} aria-current={!active ? "page" : undefined}>
        <LayoutGrid className={cn("size-[18px]", active && "text-sun")} aria-hidden />
        All
      </Link>
      {CATEGORIES.map((c) => {
        const isActive = active === c.value;
        const { icon: Icon, tone } = CATEGORY_STYLE[c.value];
        return (
          <Link key={c.value} href={qs(c.value)} className={chip(isActive)} aria-current={isActive ? "page" : undefined}>
            <Icon className={cn("size-[18px]", !isActive && CHIP_TONE[tone])} aria-hidden />
            {c.label}
          </Link>
        );
      })}
    </nav>
  );
}

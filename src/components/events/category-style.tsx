import { CalendarDays, Drama, GraduationCap, Martini, Music, Palette, Tent, Trophy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { categoryLabel } from "@/server/events/queries";
import { cn } from "@/lib/utils";

type Tone = "mint" | "coral" | "sun" | "plain";

/** Icon and colour per category; the colours cycle red / sun / orange / plain. */
export const CATEGORY_STYLE: Record<string, { icon: LucideIcon; tone: Tone }> = {
  music: { icon: Music, tone: "mint" },
  festival: { icon: Tent, tone: "coral" },
  nightlife: { icon: Martini, tone: "sun" },
  conference: { icon: CalendarDays, tone: "plain" },
  sports: { icon: Trophy, tone: "mint" },
  workshop: { icon: GraduationCap, tone: "coral" },
  comedy: { icon: Drama, tone: "sun" },
  arts: { icon: Palette, tone: "plain" },
};

/** Icon colour for chips and tiles; the chip itself stays dark glass. */
export const CHIP_TONE: Record<Tone, string> = {
  mint: "text-coral",
  coral: "text-sun",
  sun: "text-teal",
  plain: "text-coral",
};

/** Solid fills for badges sitting on photos. */
const BADGE_TONE: Record<Tone, string> = {
  mint: "bg-[#f2482f] text-white",
  coral: "bg-[#ffc53d] text-[#1d1300]",
  sun: "bg-[#ff8a2a] text-[#1d1300]",
  plain: "bg-white text-[#17110e]",
};

/** Category pill for photo cards. */
export function CategoryBadge({ category, className }: { category: string; className?: string }) {
  const style = CATEGORY_STYLE[category];
  const Icon = style?.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold shadow-md shadow-black/25",
        BADGE_TONE[style?.tone ?? "plain"],
        className,
      )}
    >
      {Icon && <Icon className="size-3.5" aria-hidden />}
      {categoryLabel(category)}
    </span>
  );
}

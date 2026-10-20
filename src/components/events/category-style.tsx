import { CalendarDays, Drama, GraduationCap, Martini, Music, Palette, Tent, Trophy } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { categoryLabel } from "@/server/events/queries";
import { cn } from "@/lib/utils";

type Tone = "mint" | "coral" | "sun" | "plain";

/** Icon and colour per category; the colours cycle mint / coral / sun / plain. */
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

/** Soft fills for chips and tiles on the page canvas. */
export const CHIP_TONE: Record<Tone, string> = {
  mint: "bg-mint text-[#0b3d36]",
  coral: "bg-coral text-white",
  sun: "bg-sun text-[#2a1d00]",
  plain: "bg-surface-2 text-fg",
};

/** Solid fills for badges sitting on photos. */
const BADGE_TONE: Record<Tone, string> = {
  mint: "bg-[#0f7f72] text-white",
  coral: "bg-[#f25f3a] text-white",
  sun: "bg-[#f7b731] text-[#2a1d00]",
  plain: "bg-white text-[#14171a]",
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

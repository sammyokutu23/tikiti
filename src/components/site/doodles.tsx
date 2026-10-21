import { cn } from "@/lib/utils";

/** Loose underline stroke for script notes. Decorative only. */
export function Underline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 10" preserveAspectRatio="none" className={cn("h-2 w-full", className)} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
      <path d="M3 7C45 3 110 2 157 4" />
    </svg>
  );
}

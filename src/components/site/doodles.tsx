import { cn } from "@/lib/utils";

/** Three short "energy" strokes, drawn as clean lines. Decorative only. */
export function Spark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-6", className)} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M12 2.5v5M4.5 6l3.2 3.6M2.5 14h4.8" />
    </svg>
  );
}

/** Loose underline stroke for script notes. Decorative only. */
export function Underline({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 160 10" preserveAspectRatio="none" className={cn("h-2 w-full", className)} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
      <path d="M3 7C45 3 110 2 157 4" />
    </svg>
  );
}

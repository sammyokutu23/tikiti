import Link from "next/link";
import { cn } from "@/lib/utils";

/** The TikoSoko cart-and-ticket mark. Colours come from the --brand-* tokens, so it follows the theme. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 58" className={className} aria-hidden>
      <path d="M3 11.5H10.5L15 25" fill="none" stroke="var(--brand-cart)" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round" />
      <g transform="rotate(-9 35 18)">
        <path
          d="M21 5H47a3 3 0 0 1 3 3V14a3.2 3.2 0 0 0 0 6.4V27a3 3 0 0 1-3 3H21a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z"
          fill="var(--brand-ticket)"
        />
        <path d="M42.5 7.5V28" stroke="var(--bg)" strokeWidth="1.6" strokeDasharray="3 2.6" strokeLinecap="round" />
        <path d="M24.5 16.5l4 4 7-8.5" fill="none" stroke="var(--brand-check)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <path d="M12 27H60L55 43H17Z" fill="var(--brand-cart)" stroke="var(--brand-cart)" strokeWidth="2" strokeLinejoin="round" />
      <rect x="16" y="47" width="38" height="3" rx="1.5" fill="var(--brand-cart)" />
      <circle cx="23" cy="54" r="3.6" fill="var(--brand-wheel)" />
      <circle cx="47" cy="54" r="3.6" fill="var(--brand-wheel)" />
    </svg>
  );
}

export function Logo({ href = "/", tagline = false }: { href?: string; tagline?: boolean }) {
  return (
    <Link href={href} className="flex items-center gap-2" aria-label="TikoSoko home">
      <LogoMark className={cn("shrink-0", tagline ? "h-11 w-12" : "h-8 w-9")} />
      <span className="flex flex-col leading-none">
        <span className={cn("font-bold tracking-tight", tagline ? "text-2xl" : "text-xl")}>
          <span className="text-[var(--brand-ink)]">Tiko</span>
          <span className="text-[var(--brand-accent)]">Soko</span>
        </span>
        {tagline && (
          <span className="mt-1 flex justify-between gap-3 text-[11px] font-medium text-muted">
            <span>Verified.</span>
            <span>Secure.</span>
            <span>Yours</span>
          </span>
        )}
      </span>
    </Link>
  );
}

import Link from "next/link";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-bold tracking-tight" aria-label="Tikiti home">
      <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-fg">
        <svg viewBox="0 0 24 24" className="size-5" aria-hidden fill="currentColor">
          <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V7Zm6 0v2h2V7h-2Zm0 4v2h2v-2h-2Zm0 4v2h2v-2h-2Z" />
        </svg>
      </span>
      <span className="text-lg">tikiti</span>
    </Link>
  );
}

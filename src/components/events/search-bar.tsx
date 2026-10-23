import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";
import { TICKET_KINDS } from "@/server/events/buy";
import { CATEGORIES } from "@/server/events/queries";
import { cn } from "@/lib/utils";

/** Dark pill search edged in a sun → red gradient glow. Plain GET form — works without JS. */
export function SearchPill({ defaultValue, className }: { defaultValue?: string; className?: string }) {
  return (
    <form
      action="/"
      role="search"
      className={cn(
        "relative rounded-full bg-gradient-to-r from-sun via-teal to-coral p-[1.5px] shadow-[0_0_28px_-6px] shadow-coral/60",
        className,
      )}
    >
      <label htmlFor="q-pill" className="sr-only">Search events</label>
      <Search className="pointer-events-none absolute left-6 top-1/2 z-10 size-5 -translate-y-1/2 text-sun" aria-hidden />
      <input
        id="q-pill"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search events, artists, venues…"
        className="h-16 w-full rounded-full bg-bg/90 pl-14 pr-16 text-base text-fg backdrop-blur-md placeholder:text-muted focus:bg-bg focus:outline-none"
      />
      <Link
        href="/#filters"
        aria-label="Filters"
        className="absolute right-3 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full text-fg/80 transition hover:bg-fg/10 hover:text-fg"
      >
        <SlidersHorizontal className="size-5" aria-hidden />
      </Link>
    </form>
  );
}

export function FilterForm({
  values,
  cities,
}: {
  values: { q?: string; category?: string; city?: string; when?: string; date?: string; type?: string; minKes?: number; maxKes?: number };
  cities: string[];
}) {
  const field = "h-12 w-full rounded-2xl border border-line bg-fg/5 px-4 text-sm focus:border-fg/40 focus:outline-none";
  return (
    <form action="/" id="filters" className="grid gap-3 rounded-3xl border border-line bg-surface/70 p-3 sm:grid-cols-2 lg:grid-cols-6">
      <div className="relative sm:col-span-2">
        <label htmlFor="f-q" className="sr-only">Keyword</label>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input id="f-q" name="q" defaultValue={values.q} placeholder="Event, artist or venue" className={cn(field, "pl-10")} />
      </div>
      <div>
        <label htmlFor="f-cat" className="sr-only">Category</label>
        <select id="f-cat" name="category" defaultValue={values.category ?? ""} className={field}>
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-city" className="sr-only">City</label>
        <select id="f-city" name="city" defaultValue={values.city ?? ""} className={field}>
          <option value="">All of Kenya</option>
          {cities.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-when" className="sr-only">When</label>
        <select id="f-when" name="when" defaultValue={values.when ?? ""} className={field}>
          <option value="">Any time</option>
          <option value="today">Today</option>
          <option value="weekend">This weekend</option>
          <option value="week">Next 7 days</option>
          <option value="month">Next 30 days</option>
        </select>
      </div>
      <div>
        <label htmlFor="f-date" className="sr-only">On a specific date</label>
        <input id="f-date" type="date" name="date" defaultValue={values.date} className={field} aria-label="Specific date" />
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="f-type" className="sr-only">Ticket type</label>
        <select id="f-type" name="type" defaultValue={values.type ?? ""} className={field}>
          <option value="">All ticket types</option>
          {TICKET_KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="f-min" className="sr-only">Lowest price (KES)</label>
        <input id="f-min" name="min" type="number" inputMode="numeric" min={0} step={50} defaultValue={values.minKes} placeholder="Min KES" className={field} />
      </div>
      <div>
        <label htmlFor="f-max" className="sr-only">Highest price (KES)</label>
        <input id="f-max" name="max" type="number" inputMode="numeric" min={0} step={50} defaultValue={values.maxKes} placeholder="Max KES" className={field} />
      </div>
      <button className="h-12 rounded-2xl bg-primary px-6 text-sm font-semibold text-primary-fg hover:bg-primary/90 sm:col-span-2">Search</button>
    </form>
  );
}

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

/**
 * One search box; the remaining filters sit behind the sliders button so the form stays compact on phones.
 * The toggle is a CSS-only checkbox (no `name`, so it is never submitted) — still works without JS.
 */
export function FilterForm({
  values,
  cities,
}: {
  values: { q?: string; category?: string; city?: string; when?: string; date?: string; type?: string; minKes?: number; maxKes?: number };
  cities: string[];
}) {
  const field = "h-11 w-full min-w-0 rounded-xl border border-line bg-fg/5 px-3 text-sm focus:border-fg/40 focus:outline-none";
  const active = [values.category, values.city, values.when, values.date, values.type, values.minKes, values.maxKes].filter(
    (v) => v !== undefined && v !== "",
  ).length;
  return (
    <form action="/" id="filters" role="search" className="rounded-3xl border border-line bg-surface/70 p-1">
      <input id="f-toggle" type="checkbox" defaultChecked={active > 0} className="peer sr-only" aria-label="Show filters" />
      <div className="relative flex items-center rounded-2xl peer-focus-visible:ring-2 peer-focus-visible:ring-fg/40">
        <label htmlFor="f-q" className="sr-only">Keyword</label>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          id="f-q"
          name="q"
          defaultValue={values.q}
          placeholder="Search events, artists, venues…"
          enterKeyHint="search"
          className="h-10 w-full min-w-0 rounded-2xl bg-transparent pl-10 pr-20 text-base text-fg placeholder:text-muted focus:outline-none"
        />
        <label
          htmlFor="f-toggle"
          title="Filters"
          className="absolute right-10 top-1/2 flex size-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-fg/80 transition hover:bg-fg/10 hover:text-fg"
        >
          <SlidersHorizontal className="size-5" aria-hidden />
          {active > 0 && (
            <span className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-fg">
              {active}
            </span>
          )}
        </label>
        <button
          aria-label="Search"
          className="absolute right-0.5 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-fg hover:bg-primary/90"
        >
          <Search className="size-4" aria-hidden />
        </button>
      </div>
      <div className="hidden grid-cols-2 gap-2 border-t border-line px-1 pb-1 pt-3 mt-2 peer-checked:grid lg:grid-cols-4">
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
          <input id="f-date" type="date" name="date" defaultValue={values.date} className={cn(field, "appearance-none text-left [&::-webkit-date-and-time-value]:text-left")} aria-label="Specific date" />
        </div>
        <div className="col-span-2">
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
        <button className="col-span-2 h-11 rounded-xl bg-primary px-6 text-sm font-semibold text-primary-fg hover:bg-primary/90 lg:col-span-4">Apply filters</button>
      </div>
    </form>
  );
}

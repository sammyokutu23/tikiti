import Link from "next/link";
import { Search, SlidersHorizontal } from "lucide-react";
import { CATEGORIES } from "@/server/events/queries";
import { cn } from "@/lib/utils";

/** White pill search with a teal filter button. Plain GET form — works without JS. */
export function SearchPill({ defaultValue, className }: { defaultValue?: string; className?: string }) {
  return (
    <form action="/events" role="search" className={cn("relative", className)}>
      <label htmlFor="q-pill" className="sr-only">Search events</label>
      <Search className="pointer-events-none absolute left-5 top-1/2 size-[22px] -translate-y-1/2 text-teal" aria-hidden />
      <input
        id="q-pill"
        name="q"
        defaultValue={defaultValue}
        placeholder="Search events, artists, venues…"
        className="h-16 w-full rounded-full border border-line bg-bg-elevated pl-14 pr-20 text-base shadow-lg shadow-black/5 placeholder:text-muted focus:border-teal/50 focus:outline-none"
      />
      <Link
        href="/events#filters"
        aria-label="Filters"
        className="absolute right-2 top-1/2 flex size-12 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-primary-fg shadow-md shadow-primary/30 transition hover:brightness-110"
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
  values: { q?: string; category?: string; city?: string; when?: string; date?: string };
  cities: string[];
}) {
  const field = "h-12 w-full rounded-2xl border border-line bg-fg/5 px-4 text-sm focus:border-fg/40 focus:outline-none";
  return (
    <form action="/events" id="filters" className="grid gap-3 rounded-3xl border border-line bg-surface/70 p-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]">
      <div className="relative sm:col-span-2 lg:col-span-1">
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
      <button className="h-12 rounded-2xl bg-primary px-6 text-sm font-semibold text-primary-fg hover:bg-primary/90">Search</button>
    </form>
  );
}

import Link from "next/link";
import { ArrowRight, Repeat, SearchX } from "lucide-react";
import { CategoryChips } from "@/components/events/category-chips";
import { EventCard } from "@/components/events/event-card";
import { FilterForm } from "@/components/events/search-bar";
import { ResaleListingCard } from "@/components/resale/listing-card";
import { ButtonLink, EmptyState } from "@/components/ui";
import { categoryLabel, isCategory, publicCities, searchPublicEvents } from "@/server/events/queries";
import { marketplaceListings } from "@/server/resale/listings";

export const metadata = { title: "Explore events" };

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 100) : undefined);

export default async function EventsPage({ searchParams }: PageProps<"/events">) {
  const sp = await searchParams;
  const values = {
    q: str(sp.q),
    category: isCategory(str(sp.category)) ? str(sp.category) : undefined,
    city: str(sp.city),
    when: str(sp.when) as "today" | "weekend" | "week" | "month" | undefined,
    date: str(sp.date),
  };
  const [results, cities, resale] = await Promise.all([
    searchPublicEvents({ ...values, limit: 60 }),
    publicCities(),
    marketplaceListings({ ...values, newest: true, limit: 6 }),
  ]);
  const filtered = Object.values(values).some(Boolean);
  const heading = values.category ? categoryLabel(values.category) : values.q ? `Results for “${values.q}”` : "All events";

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-4 pb-8 pt-6 sm:px-6 sm:pt-10">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{heading}</h1>
        <p className="text-sm text-muted" aria-live="polite">
          {results.length} {results.length === 1 ? "event" : "events"}
          {values.city ? ` in ${values.city}` : " across Kenya"}
        </p>
      </div>
      <FilterForm values={values} cities={cities} />
      <CategoryChips active={values.category} extra={{ q: values.q, city: values.city, when: values.when, date: values.date }} />
      {resale.length > 0 && (
        <section className="space-y-4 rounded-[2rem] border border-sun/25 bg-surface/70 p-4 sm:p-6" aria-labelledby="resale-heading">
          <div className="flex items-center justify-between gap-3">
            <h2 id="resale-heading" className="inline-flex items-center gap-2 text-xl font-extrabold sm:text-2xl">
              <Repeat className="size-5 text-sun" aria-hidden /> Resale tickets
            </h2>
            <Link href={values.q ? `/resale?q=${encodeURIComponent(values.q)}` : "/resale"} className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal hover:text-teal/80">
              See all <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {resale.map((r) => (
              <ResaleListingCard key={r.listing.id} row={r} />
            ))}
          </div>
        </section>
      )}
      {results.length === 0 ? (
        <EmptyState
          icon={<SearchX className="size-6" />}
          title="No events match your search"
          body="Try a different keyword, date or city — or browse everything that's coming up."
          action={filtered ? <ButtonLink href="/events" variant="secondary">Clear filters</ButtonLink> : undefined}
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {results.map((e, i) => (
            <EventCard key={e.id} event={e} priority={i < 2} />
          ))}
        </div>
      )}
      {filtered && results.length > 0 && (
        <p className="text-center text-sm text-muted">
          <Link href="/events" className="underline-offset-4 hover:underline">Clear all filters</Link>
        </p>
      )}
    </div>
  );
}

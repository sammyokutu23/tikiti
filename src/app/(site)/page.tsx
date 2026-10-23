import Image from "next/image";
import Link from "next/link";
import { SearchX, Tag } from "lucide-react";
import { BuyEventCard } from "@/components/events/buy-card";
import { CategoryChips } from "@/components/events/category-chips";
import { FilterForm } from "@/components/events/search-bar";
import { ButtonLink, EmptyState } from "@/components/ui";
import { buyCatalog, isTicketKind, TICKET_KINDS } from "@/server/events/buy";
import { categoryLabel, isCategory, publicCities } from "@/server/events/queries";

const HERO_IMAGE = "https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=1600&q=75";

/**
 * Full-bleed concert crowd washed in red stage light, darkened on the left so the
 * headline reads, with a sweeping sun-to-orange light trail. Decorative only.
 */
function HeroArt() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
      <Image src={HERO_IMAGE} alt="" fill sizes="100vw" className="object-cover object-[75%_30%]" preload />
      <div className="absolute inset-0 bg-[#e8402a] mix-blend-multiply" />
      <div className="absolute inset-0 bg-gradient-to-r from-[#0b0908] via-[#0b0908]/65 to-transparent sm:via-[#0b0908]/45" />
      <div className="absolute inset-0 bg-gradient-to-b from-[#0b0908]/50 via-transparent via-70% to-[#0b0908]" />
      <svg viewBox="0 0 800 700" preserveAspectRatio="none" className="absolute inset-y-0 right-0 hidden h-full w-[62%] xl:block" fill="none">
        <defs>
          <linearGradient id="hero-trail" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffc53d" />
            <stop offset="1" stopColor="#ff8a2a" stopOpacity="0.85" />
          </linearGradient>
        </defs>
        <path d="M60 -20C150 230 290 380 500 450" stroke="url(#hero-trail)" strokeWidth="30" strokeLinecap="round" opacity="0.8" />
      </svg>
    </div>
  );
}

/** Hand-drawn swoosh under "Shika Ticket!". Decorative only. */
function Swoosh({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 420 16" preserveAspectRatio="none" className={className} fill="none" aria-hidden>
      <defs>
        <linearGradient id="hero-swoosh" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ff8a2a" />
          <stop offset="1" stopColor="#f2482f" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d="M3 13C120 4 270 2 417 6" stroke="url(#hero-swoosh)" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

const str = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 100) : undefined);
const kes = (v: string | string[] | undefined) => {
  const n = Number(str(v));
  return str(v) && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/** Buy: every ticket for every event (organizers' and fans' resale), filterable by ticket type and price. */
export default async function BuyPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const values = {
    q: str(sp.q),
    category: isCategory(str(sp.category)) ? str(sp.category) : undefined,
    city: str(sp.city),
    when: str(sp.when) as "today" | "weekend" | "week" | "month" | undefined,
    date: str(sp.date),
    type: isTicketKind(str(sp.type)) ? (str(sp.type) as (typeof TICKET_KINDS)[number]["value"]) : undefined,
    minKes: kes(sp.min),
    maxKes: kes(sp.max),
  };
  const [results, cities] = await Promise.all([buyCatalog(values), publicCities()]);
  const filtered = Object.values(values).some((v) => v !== undefined && v !== "");
  const typeLabel = TICKET_KINDS.find((k) => k.value === values.type)?.label;
  const heading = values.category ? categoryLabel(values.category) : values.q ? `Results for “${values.q}”` : typeLabel ? `${typeLabel} tickets` : "All events";

  return (
    <>
      <section className="theme-dark relative isolate overflow-hidden text-fg">
        <HeroArt />
        <div className="relative mx-auto max-w-7xl space-y-5 px-4 pb-8 pt-8 sm:space-y-6 sm:px-6 sm:pb-12 sm:pt-12">
          <h1 className="text-[2.3rem] font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            FOMO Si Lazima,
            <span className="relative mt-1 block w-fit pb-3 sm:mt-2">
              <span className="bg-gradient-to-r from-sun via-teal to-coral bg-clip-text pr-2 italic text-transparent">Shika Ticket!</span>
              <Swoosh className="absolute -left-1 bottom-0 h-3 w-[105%]" />
            </span>
          </h1>
          <p className="max-w-xl text-base text-fg/80 sm:text-lg">
            Every ticket in one place: straight from organizers, or from fans who can&apos;t make it.
          </p>
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/resale/sell" variant="secondary">
              <Tag className="size-4" aria-hidden /> Sell a ticket
            </ButtonLink>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl space-y-6 px-4 pb-8 pt-6 sm:px-6 sm:pt-8">
        <FilterForm values={values} cities={cities} />
        <CategoryChips base="/" active={values.category} extra={{ q: values.q, city: values.city, when: values.when, date: values.date, type: values.type, min: values.minKes?.toString(), max: values.maxKes?.toString() }} />
        <div className="space-y-1">
          <h2 className="text-2xl font-extrabold sm:text-[1.75rem]">{heading}</h2>
          <p className="text-sm text-muted" aria-live="polite">
            {results.length} {results.length === 1 ? "event" : "events"}
            {values.city ? ` in ${values.city}` : " across Kenya"}
          </p>
        </div>
        {results.length === 0 ? (
          <EmptyState
            icon={<SearchX className="size-6" />}
            title="No tickets match your search"
            body="Try a different ticket type, price, date or city, or browse everything on sale."
            action={filtered ? <ButtonLink href="/" variant="secondary">Clear filters</ButtonLink> : undefined}
          />
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {results.map((e, i) => (
              <BuyEventCard key={e.id} event={e} priority={i < 2} />
            ))}
          </div>
        )}
        {filtered && results.length > 0 && (
          <p className="text-center text-sm text-muted">
            <Link href="/" className="underline-offset-4 hover:underline">Clear all filters</Link>
          </p>
        )}
      </div>
    </>
  );
}

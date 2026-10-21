import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronDown, MapPin, Ticket } from "lucide-react";
import { CategoryChips } from "@/components/events/category-chips";
import { CATEGORY_STYLE, CHIP_TONE } from "@/components/events/category-style";
import { EventCard, EventRow, FeaturedEventCard } from "@/components/events/event-card";
import { SearchPill } from "@/components/events/search-bar";
import { HomeStory } from "@/components/site/story";
import { EmptyState, Section } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CATEGORIES, searchPublicEvents } from "@/server/events/queries";

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

export default async function HomePage() {
  const [featured, thisWeek, upcoming] = await Promise.all([
    searchPublicEvents({ featured: true, limit: 6 }),
    searchPublicEvents({ when: "week", limit: 4 }),
    searchPublicEvents({ limit: 9 }),
  ]);
  const hero = featured.length ? featured : upcoming.slice(0, 3);

  return (
    <>
      <section className="theme-dark relative isolate overflow-hidden text-fg">
        <HeroArt />
        <div className="relative mx-auto max-w-7xl space-y-6 px-4 pb-10 pt-8 sm:space-y-8 sm:px-6 sm:pb-16 sm:pt-14">
          <div className="flex items-start gap-3">
            <MapPin className="mt-1 size-5 shrink-0 text-sun" aria-hidden />
            <div>
              <p className="text-sm text-fg/75">Discover in</p>
              <Link href="/events?city=Nairobi" className="inline-flex items-center gap-1 text-lg font-semibold sm:text-xl">
                Nairobi, Kenya <ChevronDown className="size-4" aria-hidden />
              </Link>
            </div>
          </div>
          <div className="space-y-4">
            <h1 className="text-[2.6rem] font-extrabold leading-[1.05] tracking-tight sm:text-7xl">
              FOMO Si Lazima,
              <span className="relative mt-1 block w-fit pb-3 sm:mt-2">
                <span className="bg-gradient-to-r from-sun via-teal to-coral bg-clip-text pr-2 italic text-transparent">Shika Ticket!</span>
                <Swoosh className="absolute -left-1 bottom-0 h-3 w-[105%]" />
              </span>
            </h1>
            <p className="max-w-xl text-base text-fg/80 sm:text-lg">
              Concerts, festivals, parties, conferences, workshops and more — all in one place.
            </p>
          </div>
          <SearchPill className="max-w-3xl" />
          <CategoryChips />
        </div>
      </section>

      <div className="mx-auto max-w-7xl space-y-12 px-4 pb-8 pt-8 sm:space-y-16 sm:px-6 sm:pt-12">
        <Section
          title={
            <span className="text-2xl font-extrabold sm:text-[1.75rem]">Featured</span>
          }
          action={
            <Link href="/events" className="inline-flex items-center gap-1.5 text-base font-semibold text-teal hover:text-teal/80">
              See all <ArrowRight className="size-4" aria-hidden />
            </Link>
          }
        >
          {hero.length === 0 ? (
            <EmptyState icon={<Ticket className="size-6" />} title="No events yet" body="Check back soon — organizers are adding new events every week." />
          ) : (
            <div className="scrollbar-none relative -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:gap-5 sm:px-6 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0">
              {hero.map((e, i) => (
                <div key={e.id} className="w-[86%] shrink-0 snap-center sm:w-[46%] lg:w-auto">
                  <FeaturedEventCard event={e} priority={i === 0} />
                </div>
              ))}
            </div>
          )}
        </Section>

        <HomeStory />

        {thisWeek.length > 0 && (
          <Section title="Happening this week" action={<Link href="/events?when=week" className="text-sm font-semibold text-teal hover:text-teal/80">See all</Link>}>
            <div className="grid gap-3 md:grid-cols-2">
              {thisWeek.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </div>
          </Section>
        )}

        <Section title="Browse by category">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {CATEGORIES.map((c) => {
              const { icon: Icon, tone } = CATEGORY_STYLE[c.value];
              return (
                <Link
                  key={c.value}
                  href={`/events?category=${c.value}`}
                  className="group flex items-center gap-3 rounded-3xl border border-line bg-surface/70 p-4 transition hover:border-sun/40 hover:bg-surface"
                >
                  <span
                    className={cn(
                      "flex size-11 items-center justify-center rounded-2xl bg-surface-2 transition group-hover:bg-primary group-hover:text-primary-fg",
                      CHIP_TONE[tone],
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <span className="text-sm font-medium">{c.label}</span>
                </Link>
              );
            })}
          </div>
        </Section>

        <Section title="Upcoming events" action={<Link href="/events" className="text-sm font-semibold text-teal hover:text-teal/80">See all</Link>}>
          {upcoming.length === 0 ? (
            <EmptyState icon={<Ticket className="size-6" />} title="Nothing scheduled yet" body="New events appear here as soon as organizers publish them." />
          ) : (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {upcoming.map((e) => (
                <EventCard key={e.id} event={e} />
              ))}
            </div>
          )}
        </Section>
      </div>
    </>
  );
}

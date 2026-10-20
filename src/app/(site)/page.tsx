import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronDown, Flame, MapPin, Repeat, Ticket } from "lucide-react";
import { CategoryChips } from "@/components/events/category-chips";
import { CATEGORY_STYLE, CHIP_TONE } from "@/components/events/category-style";
import { EventCard, EventRow, FeaturedEventCard } from "@/components/events/event-card";
import { SearchPill } from "@/components/events/search-bar";
import { Spark, Underline } from "@/components/site/doodles";
import { ButtonLink, EmptyState, Section } from "@/components/ui";
import { cn } from "@/lib/utils";
import { CATEGORIES, searchPublicEvents } from "@/server/events/queries";

const HERO_IMAGE = "https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=1600&q=75";

/**
 * Concert photo cut on a slant, edged by clean parallel stripes (sun, teal, coral)
 * instead of paint splashes. Decorative only.
 */
function HeroArt() {
  return (
    <div className="pointer-events-none absolute right-0 top-0 h-[290px] w-[44%] sm:h-[440px] lg:h-[510px] lg:w-[50%]" aria-hidden>
      <div className="absolute inset-0 bg-coral [clip-path:polygon(17%_0,18.5%_0,-1.5%_100%,-3%_100%)]" />
      <div className="absolute inset-0 bg-teal [clip-path:polygon(21.5%_0,24%_0,4%_100%,1.5%_100%)]" />
      <div className="absolute inset-0 bg-sun [clip-path:polygon(27%_0,31%_0,11%_100%,7%_100%)]" />
      <div className="absolute inset-0 [clip-path:polygon(34%_0,100%_0,100%_100%,14%_100%)]">
        <Image src={HERO_IMAGE} alt="" fill sizes="(min-width: 1024px) 50vw, 46vw" className="object-cover object-[60%_center]" preload />
        <div className="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
      </div>
    </div>
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
      <section className="relative isolate overflow-hidden">
        <HeroArt />
        <div className="relative mx-auto max-w-7xl space-y-6 px-4 pb-4 pt-5 sm:space-y-8 sm:px-6 sm:pt-12">
          <div className="flex items-start gap-2">
            <MapPin className="mt-1 size-5 shrink-0 text-teal sm:hidden" aria-hidden />
            <div>
              <p className="text-sm text-fg/80">Discover in</p>
              <Link href="/events?city=Nairobi" className="inline-flex items-center gap-1 text-xl font-bold sm:text-2xl">
                Nairobi, Kenya <ChevronDown className="size-5" aria-hidden />
              </Link>
            </div>
          </div>
          <div className="space-y-3">
            <h1 className="relative z-10 text-[2.4rem] font-extrabold leading-[1.05] tracking-tight sm:text-7xl">
              FOMO Si <br className="sm:hidden" />
              Lazima,
              <span className="relative isolate mt-1 flex w-fit items-center sm:mt-2">
                <Spark className="absolute -left-4 top-1/2 size-4 -translate-y-1/2 -rotate-90 text-fg sm:-left-8 sm:size-7" />
                <span className="absolute -inset-x-2 bottom-[0.18em] top-[0.42em] -z-10 -rotate-1 rounded-lg bg-sun" aria-hidden />
                <span className="font-script text-[1.15em] font-bold sm:text-[1.3em] leading-[0.95] tracking-normal text-[#0b6b60]">Shika Ticket!</span>
                <Spark className="ml-2 hidden size-8 rotate-180 text-teal sm:block" />
              </span>
            </h1>
            <p className="ml-[22%] flex w-fit -rotate-6 flex-col font-script text-2xl font-bold text-teal sm:ml-[34%] sm:text-3xl">
              <span>Plans za leo?</span>
              <Underline className="-mt-1 text-teal" />
            </p>
            <p className="hidden max-w-xl text-lg text-muted sm:block">
              Concerts, festivals, parties, conferences, workshops and more — all in one place.
            </p>
          </div>
          <SearchPill className="relative z-10 max-w-3xl" />
          <div className="relative">
            <Spark className="absolute -left-7 -top-3 hidden size-6 -rotate-45 text-fg sm:block" />
            <CategoryChips />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-7xl space-y-12 px-4 pb-8 pt-8 sm:space-y-16 sm:px-6 sm:pt-12">
        <Section
          title={
            <span className="flex items-center gap-2 text-2xl font-extrabold sm:text-[1.75rem]">
              <Flame className="size-7 fill-coral text-coral" aria-hidden />
              Featured
            </span>
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
            <div className="scrollbar-none relative -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-4 sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-5 sm:overflow-visible sm:px-0 lg:grid-cols-3">
              {hero.map((e, i) => (
                <div key={e.id} className="w-[86%] shrink-0 snap-center sm:w-auto">
                  <FeaturedEventCard event={e} priority={i === 0} />
                </div>
              ))}
            </div>
          )}
        </Section>

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
                  className="group flex items-center gap-3 rounded-3xl border border-line bg-surface/70 p-4 transition hover:border-teal/40 hover:bg-surface"
                >
                  <span
                    className={cn(
                      "flex size-11 items-center justify-center rounded-2xl transition group-hover:bg-primary group-hover:text-primary-fg",
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

        <section className="flex flex-col gap-5 rounded-[2rem] bg-[#14181b] p-6 text-white sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div className="max-w-xl space-y-2">
            <p className="font-script text-2xl font-bold text-[#f7b731]">Plans changed?</p>
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Buy and sell tickets with other fans</h2>
            <p className="text-sm text-white/75">
              Resell your TikoSoko ticket, or one you bought elsewhere. Buyers get a fresh ticket or a reviewed one, and sellers are paid after the event.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <ButtonLink href="/resale" size="lg">
              <Repeat className="size-4" aria-hidden /> Resale tickets
            </ButtonLink>
            <ButtonLink href="/resale/sell" size="lg" variant="outline" className="border-white/25 text-white hover:bg-white/10">
              Sell yours
            </ButtonLink>
          </div>
        </section>

        <section className="relative overflow-hidden rounded-[2rem] border border-line bg-[radial-gradient(600px_300px_at_100%_0%,rgb(15_127_114/0.14),transparent_70%)] bg-surface p-6 sm:p-10">
          <div className="max-w-xl space-y-4">
            <p className="text-sm font-medium text-muted">For organizers</p>
            <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">Sell tickets with QR check-in and same-day reporting.</h2>
            <p className="text-sm text-muted">
              Create your event in minutes, sell M-Pesa and card tickets, and scan guests in from any phone. A simple {""}
              commission on paid tickets — free events are free.
            </p>
            <ButtonLink href="/organizer/apply" size="lg">
              Start selling <ArrowRight className="size-4" aria-hidden />
            </ButtonLink>
          </div>
        </section>
      </div>
    </>
  );
}

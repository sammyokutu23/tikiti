import Link from "next/link";
import { ArrowRight, Briefcase, ChevronDown, Drama, MicVocal, Moon, Music, Palette, Tent, Ticket, Trophy } from "lucide-react";
import { CategoryChips } from "@/components/events/category-chips";
import { EventCard, EventRow } from "@/components/events/event-card";
import { SearchPill } from "@/components/events/search-bar";
import { ButtonLink, EmptyState, IconLink, Section } from "@/components/ui";
import { CATEGORIES, searchPublicEvents } from "@/server/events/queries";

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  music: Music,
  festival: Tent,
  nightlife: Moon,
  conference: Briefcase,
  sports: Trophy,
  workshop: Palette,
  comedy: MicVocal,
  arts: Drama,
};

export default async function HomePage() {
  const [featured, thisWeek, upcoming] = await Promise.all([
    searchPublicEvents({ featured: true, limit: 6 }),
    searchPublicEvents({ when: "week", limit: 4 }),
    searchPublicEvents({ limit: 9 }),
  ]);
  const hero = featured.length ? featured : upcoming.slice(0, 3);

  return (
    <div className="mx-auto max-w-7xl space-y-12 px-4 pb-8 pt-5 sm:space-y-16 sm:px-6 sm:pt-10">
      {/* Discover header (mobile) / hero (desktop) */}
      <section className="space-y-5 sm:space-y-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs text-muted sm:text-sm">Discover in</p>
            <Link href="/events?city=Nairobi" className="mt-0.5 inline-flex items-center gap-1 text-lg font-semibold sm:text-xl">
              Nairobi, Kenya <ChevronDown className="size-4 text-muted" aria-hidden />
            </Link>
          </div>
          <IconLink href="/account" label="My tickets" className="md:hidden">
            <Ticket className="size-5" aria-hidden />
          </IconLink>
        </div>
        <h1 className="max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-6xl">
          Find your next <span className="text-muted">unforgettable</span> night out.
        </h1>
        <SearchPill className="max-w-2xl" />
        <CategoryChips />
      </section>

      {/* Featured carousel */}
      <Section title="Featured" action={<Link href="/events" className="text-sm text-muted hover:text-fg">See all</Link>}>
        {hero.length === 0 ? (
          <EmptyState icon={<Ticket className="size-6" />} title="No events yet" body="Check back soon — organizers are adding new events every week." />
        ) : (
          <div className="scrollbar-none relative -mx-4 flex snap-x snap-mandatory gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
            {hero.map((e, i) => (
              <div key={e.id} className="w-[85%] shrink-0 snap-center sm:w-auto">
                <EventCard event={e} priority={i === 0} />
              </div>
            ))}
          </div>
        )}
      </Section>

      {thisWeek.length > 0 && (
        <Section title="Happening this week" action={<Link href="/events?when=week" className="text-sm text-muted hover:text-fg">See all</Link>}>
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
            const Icon = CATEGORY_ICONS[c.value];
            return (
              <Link
                key={c.value}
                href={`/events?category=${c.value}`}
                className="group flex items-center gap-3 rounded-3xl border border-line bg-surface/70 p-4 transition hover:border-line-strong hover:bg-surface"
              >
                <span className="flex size-11 items-center justify-center rounded-2xl bg-white/8 transition group-hover:bg-white group-hover:text-black">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-medium">{c.label}</span>
              </Link>
            );
          })}
        </div>
      </Section>

      <Section title="Upcoming events" action={<Link href="/events" className="text-sm text-muted hover:text-fg">See all</Link>}>
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

      <section className="relative overflow-hidden rounded-[2rem] border border-line bg-gradient-to-br from-surface-2 via-surface to-bg p-6 sm:p-10">
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
  );
}

import Link from "next/link";
import { ArrowRight, Clock, MapPin, Ticket } from "lucide-react";
import type { EventCard as EventCardData } from "@/server/events/queries";
import { dateBadge, formatEventDate, formatTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { CategoryBadge } from "./category-style";
import { EventImage } from "./event-image";

export function DateBadge({ date, tz, className }: { date: Date; tz: string; className?: string }) {
  const b = dateBadge(date, tz);
  return (
    <div className={cn("flex min-w-14 flex-col items-center rounded-2xl bg-[#14181b]/90 px-3 pb-2 pt-1.5 text-center leading-none shadow-lg shadow-black/30", className)}>
      <span className="text-xs font-medium text-white/85">{b.month}</span>
      <span className="mt-1 text-xl font-bold text-white">{b.day}</span>
      <span className="mt-1.5 h-0.5 w-5 rounded-full bg-[#f7b731]" aria-hidden />
    </div>
  );
}

export function PriceFrom({ minPriceMinor }: { minPriceMinor: number | null }) {
  if (minPriceMinor === null) return <span>Tickets TBA</span>;
  return <span>{minPriceMinor === 0 ? "Free" : `From ${formatMoney(minPriceMinor)}`}</span>;
}

/** Large image-first card (reference: home feed cards with a frosted date badge). */
export function EventCard({ event, priority = false }: { event: EventCardData; priority?: boolean }) {
  const soldOut = event.available <= 0;
  return (
    <Link
      href={`/events/${event.slug}`}
      className="group relative block overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface transition hover:border-line-strong focus-visible:outline-offset-4"
    >
      <div className="relative">
        <EventImage src={event.coverImageUrl} alt="" width={900} preload={priority} className="aspect-[16/10] transition duration-500 group-hover:scale-[1.02]" />
        <div className="absolute inset-0 img-fade opacity-60" />
        <DateBadge date={event.startsAt} tz={event.timezone} className="absolute right-3 top-3" />
        <CategoryBadge category={event.category} className="absolute left-3 top-3" />
        {soldOut && (
          <span className="absolute bottom-3 left-3 rounded-full bg-white px-3 py-1 text-xs font-semibold text-black">Sold out</span>
        )}
      </div>
      <div className="space-y-2 p-4 sm:p-5">
        <h3 className="line-clamp-2 text-lg font-semibold leading-snug tracking-tight">{event.title}</h3>
        <p className="flex items-center gap-1.5 truncate text-sm text-muted">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {event.venueName}, {event.city}
          </span>
        </p>
        <div className="flex items-center gap-4 pt-1 text-xs text-fg/75">
          <span className="flex items-center gap-1.5">
            <Ticket className="size-3.5" aria-hidden />
            <PriceFrom minPriceMinor={event.minPriceMinor} />
          </span>
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5" aria-hidden />
            <span className="sr-only">{formatEventDate(event.startsAt, event.timezone)}, </span>
            {formatTime(event.startsAt, event.timezone)}
          </span>
        </div>
      </div>
    </Link>
  );
}

/** Photo-over-dark-panel card for the home "Featured" row, with a city tag and a Get Tickets cue. */
export function FeaturedEventCard({ event, priority = false }: { event: EventCardData; priority?: boolean }) {
  const soldOut = event.available <= 0;
  return (
    <Link
      href={`/events/${event.slug}`}
      className="group relative block overflow-hidden rounded-[var(--radius-card)] bg-[#14181b] text-white shadow-xl shadow-black/15 transition hover:-translate-y-0.5 hover:shadow-2xl focus-visible:outline-offset-4"
    >
      <div className="relative">
        <EventImage src={event.coverImageUrl} alt="" width={900} preload={priority} className="aspect-[16/9] transition duration-500 group-hover:scale-[1.03]" />
        <CategoryBadge category={event.category} className="absolute left-4 top-4" />
        <DateBadge date={event.startsAt} tz={event.timezone} className="absolute right-4 top-4" />
        <span className="absolute bottom-3 left-4 -rotate-6 rounded-md bg-[#ffc53d] px-2.5 py-0.5 font-script text-lg font-bold text-[#1d1300] shadow-md shadow-black/30">
          #{event.city.replace(/\s+/g, "")}Vibes
        </span>
      </div>
      {/* Narrow cards (phones) put Get Tickets on its own full-width row. */}
      <div className="@container space-y-2 p-4 sm:p-5">
        <h3 className="line-clamp-1 text-lg font-bold tracking-tight sm:text-xl">{event.title}</h3>
        <div className="flex flex-col gap-3 @[22rem]:flex-row @[22rem]:items-end @[22rem]:justify-between">
          <div className="min-w-0 space-y-1.5 text-sm text-white/85">
            <p className="flex items-center gap-1.5 truncate">
              <MapPin className="size-4 shrink-0" aria-hidden />
              <span className="truncate">
                {event.venueName}, {event.city}
              </span>
            </p>
            <p className="flex items-center gap-1.5 whitespace-nowrap">
              <Clock className="size-4 shrink-0" aria-hidden />
              <PriceFrom minPriceMinor={event.minPriceMinor} />
              <span aria-hidden>·</span>
              <span className="sr-only">{formatEventDate(event.startsAt, event.timezone)}, </span>
              {formatTime(event.startsAt, event.timezone)}
            </p>
          </div>
          <span
            className={cn(
              "inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full px-4 text-sm font-semibold transition",
              soldOut ? "bg-white/15 text-white/80" : "bg-[#f25f3a] text-white group-hover:bg-[#e14f2b]",
            )}
          >
            {soldOut ? "Sold out" : "Get Tickets"}
            {!soldOut && <ArrowRight className="size-4" aria-hidden />}
          </span>
        </div>
      </div>
    </Link>
  );
}

/** Compact horizontal row for lists. */
export function EventRow({ event }: { event: EventCardData }) {
  return (
    <Link href={`/events/${event.slug}`} className="relative flex items-center gap-4 rounded-3xl border border-line bg-surface/70 p-3 transition hover:border-line-strong">
      <div className="relative shrink-0">
        <EventImage src={event.coverImageUrl} alt="" width={240} sizes="96px" className="size-20 rounded-2xl sm:size-24" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs font-medium text-muted">{formatEventDate(event.startsAt, event.timezone)} · {formatTime(event.startsAt, event.timezone)}</p>
        <p className="line-clamp-1 font-semibold">{event.title}</p>
        <p className="truncate text-sm text-muted">{event.venueName}, {event.city}</p>
        <p className="text-xs text-fg/80"><PriceFrom minPriceMinor={event.minPriceMinor} /></p>
      </div>
    </Link>
  );
}

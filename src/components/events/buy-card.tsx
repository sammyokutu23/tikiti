import Link from "next/link";
import { ChevronRight, MapPin, Repeat } from "lucide-react";
import type { BuyEvent, BuyOption } from "@/server/events/buy";
import { formatEventDate, formatTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { CategoryBadge } from "./category-style";
import { DateBadge } from "./event-card";
import { EventImage } from "./event-image";

const MAX_OPTIONS = 5;

function OptionRow({ o }: { o: BuyOption }) {
  const unavailable = o.kind === "primary" && o.state !== "on_sale";
  return (
    <li>
      <Link
        href={o.href}
        className={cn("flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-fg/6", unavailable && "opacity-60")}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{o.name}</span>
          <span className="block text-xs text-muted">
            {o.kind === "resale" ? (
              <span className="inline-flex items-center gap-1 font-semibold text-sun">
                <Repeat className="size-3" aria-hidden /> Resale · {o.trust === "platform" ? "verified TikoSoko ticket" : "outside ticket, reviewed"}
              </span>
            ) : o.state === "sold_out" ? (
              "Sold out"
            ) : o.state === "upcoming" ? (
              "Sales open soon"
            ) : o.remaining <= 20 ? (
              `Only ${o.remaining} left`
            ) : (
              "From the organizer"
            )}
          </span>
        </span>
        <span className="text-right text-sm font-bold tabular-nums">{o.priceMinor === 0 ? "Free" : formatMoney(o.priceMinor)}</span>
        <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
      </Link>
    </li>
  );
}

/** One event with every ticket on sale for it: the organizer's and fans' resale tickets. */
export function BuyEventCard({ event, priority = false }: { event: BuyEvent; priority?: boolean }) {
  const shown = event.options.slice(0, MAX_OPTIONS);
  const resaleCount = event.options.filter((o) => o.kind === "resale").length;
  return (
    <article className="flex flex-col overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface sm:flex-row">
      <Link href={event.href} className="relative block shrink-0 sm:w-64" aria-label={event.title}>
        <EventImage src={event.coverImageUrl} alt="" width={600} sizes="(max-width: 640px) 100vw, 256px" preload={priority} className="aspect-[16/9] size-full sm:aspect-auto" />
        <DateBadge date={event.startsAt} tz={event.timezone} className="absolute right-3 top-3" />
        {!event.isExternal && <CategoryBadge category={event.category} className="absolute left-3 top-3" />}
      </Link>
      <div className="min-w-0 flex-1 space-y-3 p-4 sm:p-5">
        <div className="space-y-1">
          <h3 className="text-lg font-bold leading-snug tracking-tight">
            <Link href={event.href} className="hover:text-teal">{event.title}</Link>
          </h3>
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <MapPin className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              {event.venueName}, {event.city} · {formatEventDate(event.startsAt, event.timezone)}, {formatTime(event.startsAt, event.timezone)}
            </span>
          </p>
        </div>
        {event.options.length === 0 ? (
          <p className="rounded-2xl bg-fg/5 px-3 py-2.5 text-sm text-muted">No tickets on sale right now.</p>
        ) : (
          <ul className="-mx-1 divide-y divide-line">
            {shown.map((o) => (
              <OptionRow key={`${o.kind}-${o.id}`} o={o} />
            ))}
          </ul>
        )}
        {(event.options.length > MAX_OPTIONS || resaleCount > 0) && (
          <p className="text-xs text-muted">
            {event.options.length} ticket option{event.options.length === 1 ? "" : "s"}
            {resaleCount > 0 ? ` · ${resaleCount} from fans reselling` : ""}
            {event.options.length > MAX_OPTIONS && (
              <>
                {" · "}
                <Link href={event.href} className="font-semibold text-teal hover:underline">See all</Link>
              </>
            )}
          </p>
        )}
      </div>
    </article>
  );
}

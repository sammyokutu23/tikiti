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

/** Tickets with the same name (organizer's tier and fans' resale alike) collapse into one row. */
type OptionGroup = { key: string; name: string; options: BuyOption[] };

function groupOptions(options: BuyOption[]): OptionGroup[] {
  const groups = new Map<string, OptionGroup>();
  for (const o of options) {
    const key = o.name.trim().replace(/\s+/g, " ").toLowerCase();
    const g = groups.get(key);
    if (g) g.options.push(o);
    else groups.set(key, { key, name: o.name.trim(), options: [o] });
  }
  // Options arrive cheapest first, so groups do too.
  return [...groups.values()];
}

const available = (o: BuyOption) => o.kind === "resale" || o.state === "on_sale";

function GroupRow({ g, eventHref, isExternal }: { g: OptionGroup; eventHref: string; isExternal: boolean }) {
  const buyable = g.options.filter(available);
  const priced = buyable.length ? buyable : g.options;
  const cheapest = priced.reduce((a, b) => (b.priceMinor < a.priceMinor ? b : a));
  const varied = priced.some((o) => o.priceMinor !== cheapest.priceMinor);
  const resale = g.options.filter((o) => o.kind === "resale");
  const primary = g.options.find((o) => o.kind === "primary");
  // A single ticket opens directly; a group opens the event page, which lists every ticket for it.
  const href = g.options.length === 1 || isExternal ? cheapest.href : eventHref;

  const notes: React.ReactNode[] = [];
  if (primary?.kind === "primary") {
    if (primary.state === "sold_out") notes.push("Sold out");
    else if (primary.state === "upcoming") notes.push("Sales open soon");
    else if (primary.remaining <= 20) notes.push(`Only ${primary.remaining} left`);
  }
  if (resale.length > 0) {
    const label =
      resale.length > 1
        ? `${resale.length} resale tickets`
        : `Resale · ${resale[0].kind === "resale" && resale[0].trust === "platform" ? "verified TikoSoko ticket" : "outside ticket, reviewed"}`;
    notes.push(
      <span key="resale" className="inline-flex items-center gap-1 font-semibold text-sun">
        <Repeat className="size-3" aria-hidden /> {label}
      </span>,
    );
  }

  return (
    <li>
      <Link
        href={href}
        className={cn("flex items-center gap-3 rounded-2xl px-3 py-2.5 transition hover:bg-fg/6", buyable.length === 0 && "opacity-60")}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{g.name}</span>
          {notes.length > 0 && (
            <span className="block text-xs text-muted">
              {notes.map((n, i) => (
                <span key={i}>
                  {i > 0 && " · "}
                  {n}
                </span>
              ))}
            </span>
          )}
        </span>
        <span className="text-right text-sm font-bold tabular-nums">
          {varied && <span className="block text-[11px] font-medium text-muted">from</span>}
          {cheapest.priceMinor === 0 ? "Free" : formatMoney(cheapest.priceMinor)}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden />
      </Link>
    </li>
  );
}

/** One event with every ticket on sale for it: the organizer's and fans' resale tickets. */
export function BuyEventCard({ event, priority = false }: { event: BuyEvent; priority?: boolean }) {
  const groups = groupOptions(event.options);
  const shown = groups.slice(0, MAX_OPTIONS);
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
            {shown.map((g) => (
              <GroupRow key={g.key} g={g} eventHref={event.href} isExternal={event.isExternal} />
            ))}
          </ul>
        )}
        {(groups.length > MAX_OPTIONS || resaleCount > 0) && (
          <p className="text-xs text-muted">
            {event.options.length} ticket option{event.options.length === 1 ? "" : "s"}
            {resaleCount > 0 ? ` · ${resaleCount} from fans reselling` : ""}
            {groups.length > MAX_OPTIONS && (
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

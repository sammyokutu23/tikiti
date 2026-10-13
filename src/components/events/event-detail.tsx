import Link from "next/link";
import { ArrowLeft, BadgeCheck, CalendarDays, Clock, Flag, MapPin, MapPinOff, Navigation, ShieldCheck } from "lucide-react";
import { directionsUrl, eventCoordinates, mapsSearchUrl } from "@/lib/location";
import { VenueMap } from "@/components/maps/venue-map";
import { buttonClasses } from "@/components/ui";
import type { PublicEventDetail } from "@/server/events/queries";
import { categoryLabel } from "@/server/events/queries";
import { formatEventDate, formatShortDate, formatTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { Alert, Card, IconLink } from "@/components/ui";
import { EventImage } from "./event-image";
import { ShareButton } from "./share-button";
import { TicketSelector } from "./ticket-selector";

export function EventDetailView({
  detail,
  mode,
  backHref = "/events",
  disabledReason,
}: {
  detail: PublicEventDetail;
  mode: "public" | "preview";
  backHref?: string;
  disabledReason?: string | null;
}) {
  const { event, organizer, ticketTypes } = detail;
  const tz = event.timezone;
  const onSalePrices = ticketTypes.filter((t) => t.saleState === "on_sale").map((t) => t.priceMinor);
  const allPrices = ticketTypes.map((t) => t.priceMinor);
  const from = (onSalePrices.length ? onSalePrices : allPrices).reduce((a, b) => Math.min(a, b), Infinity);
  const coords = eventCoordinates(event);
  const fullAddress = [event.venueAddress, event.city].filter(Boolean).join(", ");
  const multiDay = formatEventDate(event.startsAt, tz) !== formatEventDate(new Date(event.endsAt.getTime() - 6 * 3600_000), tz);

  return (
    <div className="mx-auto max-w-7xl px-4 pb-36 pt-4 sm:px-6 sm:pt-8 lg:pb-12">
      <div className="grid gap-8 lg:grid-cols-[1fr_420px] lg:gap-12">
        <div className="space-y-7">
          <div className="relative">
            <EventImage
              src={event.coverImageUrl}
              alt={event.title}
              width={1600}
              preload
              sizes="(max-width: 1024px) 100vw, 60vw"
              className="aspect-[16/11] w-full rounded-[2rem] sm:aspect-[16/9]"
            />
            <div className="absolute inset-x-3 top-3 flex items-center justify-between">
              <IconLink href={backHref} label="Back" className="glass border border-white/10 text-white">
                <ArrowLeft className="size-5" aria-hidden />
              </IconLink>
              <ShareButton title={event.title} />
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-muted">{categoryLabel(event.category)}</p>
            <h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl">{event.title}</h1>
            {Number.isFinite(from) && (
              <p className="text-base text-fg/80">{from === 0 ? "Free entry" : `Starts from ${formatMoney(from)}`}</p>
            )}
          </div>

          <div className="space-y-4">
            <div className="flex gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white/8"><CalendarDays className="size-5" aria-hidden /></span>
              <div>
                <p className="font-semibold">
                  {multiDay ? `${formatShortDate(event.startsAt, tz)} – ${formatEventDate(event.endsAt, tz)}` : formatEventDate(event.startsAt, tz)}
                </p>
                <p className="text-sm text-muted">
                  <Clock className="mr-1 inline size-3.5 align-[-2px]" aria-hidden />
                  {formatTime(event.startsAt, tz)} – {formatTime(event.endsAt, tz)} {tz === "Africa/Nairobi" ? "EAT" : tz}
                </p>
              </div>
            </div>
            <div className="flex gap-4">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white/8"><MapPin className="size-5" aria-hidden /></span>
              <div>
                <p className="font-semibold">{event.venueName}</p>
                <p className="text-sm text-muted">{fullAddress}</p>
                <a href="#location" className="mt-1 inline-block text-sm text-fg/80 underline-offset-4 hover:underline">
                  {coords ? "View map & directions" : "Location details"}
                </a>
              </div>
            </div>
          </div>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Details</h2>
            <div className="space-y-3 whitespace-pre-line leading-relaxed text-fg/75">{event.description}</div>
          </section>

          <section id="location" className="scroll-mt-24 space-y-3" aria-labelledby="location-h">
            <h2 id="location-h" className="text-lg font-semibold">Location</h2>
            {coords ? (
              <>
                <VenueMap lat={coords.lat} lng={coords.lng} label={`${event.venueName}, ${fullAddress}`} className="aspect-[4/3] w-full sm:aspect-[16/9]" />
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold">{event.venueName}</p>
                    <p className="text-sm text-muted">{fullAddress}</p>
                  </div>
                  <a href={directionsUrl(coords)} target="_blank" rel="noopener noreferrer" className={buttonClasses("primary", "md")}>
                    <Navigation className="size-4" aria-hidden /> Get directions
                  </a>
                </div>
              </>
            ) : (
              <Card className="flex gap-4 p-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-white/8"><MapPinOff className="size-5" aria-hidden /></span>
                <div className="space-y-1 text-sm">
                  <p className="font-semibold">{event.venueName}</p>
                  <p className="text-muted">{fullAddress}</p>
                  <p className="text-xs text-subtle">The organizer hasn&apos;t pinned the exact location yet, so we can&apos;t show a map.</p>
                  <a href={mapsSearchUrl([event.venueName, event.venueAddress, event.city, "Kenya"])} target="_blank" rel="noopener noreferrer" className="inline-block text-fg/85 underline-offset-4 hover:underline">
                    Search this address in Google Maps (approximate)
                  </a>
                </div>
              </Card>
            )}
            {event.arrivalInstructions && (
              <div className="rounded-2xl bg-white/5 p-4 text-sm">
                <p className="font-medium">Arrival &amp; entrance</p>
                <p className="mt-1 whitespace-pre-line text-fg/75">{event.arrivalInstructions}</p>
              </div>
            )}
          </section>

          <Card className="flex items-center gap-4 p-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-white text-lg font-bold text-black">
              {organizer.displayName.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted">Organized by</p>
              <p className="flex items-center gap-1.5 font-semibold">
                {organizer.displayName} <BadgeCheck className="size-4 text-info" aria-label="Verified organizer" />
              </p>
              {organizer.bio && <p className="line-clamp-2 text-sm text-muted">{organizer.bio}</p>}
            </div>
          </Card>

          <section className="space-y-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="size-5" aria-hidden /> Refund &amp; cancellation policy</h2>
            <p className="whitespace-pre-line text-sm leading-relaxed text-fg/75">{event.refundPolicy}</p>
            <p className="text-xs text-subtle">If the organizer cancels the event, every ticket is refunded automatically.</p>
          </section>

          {mode === "public" && (
            <Link href={`/events/${event.slug}/report`} className="inline-flex items-center gap-1.5 text-xs text-subtle hover:text-fg">
              <Flag className="size-3.5" aria-hidden /> Report this event
            </Link>
          )}
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="Tickets">
          <div className="space-y-4 lg:rounded-[2rem] lg:border lg:border-line lg:bg-surface/50 lg:p-5">
            <h2 className="text-lg font-semibold">Tickets</h2>
            {event.status === "cancelled" ? (
              <Alert tone="danger" title="This event has been cancelled">
                {event.cancellationReason ?? "All ticket holders have been refunded."}
              </Alert>
            ) : ticketTypes.length === 0 ? (
              <p className="text-sm text-muted">Tickets aren&apos;t on sale yet.</p>
            ) : (
              <TicketSelector
                slug={event.slug}
                disabledReason={disabledReason ?? (event.endsAt <= new Date() ? "This event has ended." : null)}
                types={ticketTypes.map((t) => ({
                  id: t.id,
                  name: t.name,
                  description: t.description,
                  priceMinor: t.priceMinor,
                  remaining: t.remaining,
                  maxPerOrder: t.maxPerOrder,
                  saleState: t.saleState,
                  salesStartLabel: t.salesStartAt ? formatShortDate(t.salesStartAt, tz) : null,
                  salesEndLabel: t.salesEndAt ? formatShortDate(t.salesEndAt, tz) : null,
                }))}
              />
            )}
            <p className="hidden text-xs text-subtle lg:block">Secure checkout · Instant QR tickets by email · M-Pesa &amp; card (simulated in this prototype)</p>
          </div>
        </aside>
      </div>
    </div>
  );
}

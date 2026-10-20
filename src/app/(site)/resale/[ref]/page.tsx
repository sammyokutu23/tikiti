import Link from "next/link";
import { ArrowLeft, CalendarDays, Info, MapPin, Repeat } from "lucide-react";
import { EventImage } from "@/components/events/event-image";
import { ResaleTrustBadge } from "@/components/resale/listing-card";
import { Alert, ButtonLink, Card, EmptyState, IconLink } from "@/components/ui";
import { randomToken } from "@/lib/crypto";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { getCurrentUser } from "@/server/auth/session";
import { getBuyableListing } from "@/server/resale/listings";
import { PAYOUT_HOLD_HOURS, resaleFeeMinor } from "@/server/resale/policy";
import { ResaleBuyForm } from "../forms";

export const metadata = { title: "Resale ticket" };

export default async function ResaleListingPage({ params }: PageProps<"/resale/[ref]">) {
  const { ref } = await params;
  const row = await getBuyableListing(ref);
  if (!row) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <EmptyState icon={<Repeat className="size-6" />} title="This ticket is no longer for sale" body="It may have sold, been withdrawn, or the event has passed." action={<ButtonLink href="/resale">Browse resale tickets</ButtonLink>} />
      </div>
    );
  }
  const { listing, event } = row;
  const user = await getCurrentUser();
  const own = user?.id === listing.sellerUserId;
  const fee = resaleFeeMinor(listing.priceMinor);
  const external = listing.kind === "external";

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-5 sm:px-6 sm:pt-10">
      <div className="mb-6 flex items-center gap-3">
        <IconLink href="/resale" label="Back to resale marketplace"><ArrowLeft className="size-5" aria-hidden /></IconLink>
        <div>
          <p className="text-xs text-muted">Resale · {listing.reference}</p>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{event.title}</h1>
        </div>
      </div>

      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card className="overflow-hidden">
            <EventImage src={event.coverImageUrl} alt="" width={1200} className="aspect-[16/7] w-full" />
            <div className="space-y-3 p-5">
              <ResaleTrustBadge kind={listing.kind} />
              <p className="flex items-center gap-2 text-sm"><CalendarDays className="size-4 text-muted" aria-hidden />{formatDateTime(event.startsAt, event.timezone)}</p>
              <p className="flex items-center gap-2 text-sm"><MapPin className="size-4 text-muted" aria-hidden />{event.venueName}, {event.city}</p>
              {!event.isExternal && (
                <Link href={`/events/${event.slug}`} className="inline-block text-sm font-semibold text-teal hover:underline">Event details →</Link>
              )}
            </div>
          </Card>

          {external ? (
            <Alert tone="info" title="Bought on another platform">
              This ticket was bought{listing.externalPlatform ? ` on ${listing.externalPlatform}` : " elsewhere"}. Our team checked the ticket and the seller&apos;s proof of purchase before listing it. After you pay you&apos;ll download the seller&apos;s ticket file. If it doesn&apos;t get you in, report it from your booking page within {PAYOUT_HOLD_HOURS.external} hours after the event for a full refund.
            </Alert>
          ) : (
            <Alert tone="success" title="Verified TikoSoko ticket">
              The moment you pay, the seller&apos;s ticket is cancelled and you get a brand-new ticket with its own QR code, emailed to you and saved in your booking.
            </Alert>
          )}
          {listing.sellerNote && (
            <Card className="flex gap-3 p-4 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
              <p><span className="font-semibold">Seller&apos;s note:</span> {listing.sellerNote}</p>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          <Card className="space-y-2.5 p-5 text-sm">
            <h2 className="font-semibold">{listing.ticketTypeName}</h2>
            <div className="flex justify-between gap-4 text-muted"><span>Ticket price</span><span className="tabular-nums">{formatAmount(listing.priceMinor)}</span></div>
            <div className="flex justify-between gap-4 text-muted"><span>Resale fee (10%)</span><span className="tabular-nums">{formatAmount(fee)}</span></div>
            <div className="flex justify-between gap-4 border-t border-line pt-2.5 text-base font-bold"><span>Total</span><span className="tabular-nums">{formatMoney(listing.priceMinor + fee)}</span></div>
          </Card>
          <Card className="p-5">
            {own ? (
              <div className="space-y-3 text-sm">
                <p className="text-muted">This is your listing.</p>
                <ButtonLink href="/resale/mine" variant="secondary" full>Manage my listings</ButtonLink>
              </div>
            ) : !user ? (
              <div className="space-y-3 text-sm">
                <p className="text-muted">Sign in or create a free account to buy this ticket. Your ticket is saved to My tickets.</p>
                <ButtonLink href={`/sign-in?redirect_url=${encodeURIComponent(`/resale/${listing.reference}`)}`} full size="lg">Sign in to buy · {formatMoney(listing.priceMinor + fee)}</ButtonLink>
                <ButtonLink href={`/sign-up?redirect_url=${encodeURIComponent(`/resale/${listing.reference}`)}`} variant="ghost" full>Create an account</ButtonLink>
              </div>
            ) : (
              <ResaleBuyForm
                listingId={listing.id}
                idempotencyKey={`rck_${randomToken(18)}`}
                totalMinor={listing.priceMinor + fee}
                external={external}
                defaults={{ name: user.name, email: user.email, phone: user.phone ? formatPhone(user.phone) : undefined }}
              />
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}

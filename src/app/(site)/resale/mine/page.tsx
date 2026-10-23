import { Repeat, Tag } from "lucide-react";
import { Flash } from "@/components/dash/flash";
import { LISTING_STATUS, ResaleTrustBadge } from "@/components/resale/listing-card";
import { Badge, ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { env } from "@/lib/env";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";
import { sellerListings } from "@/server/resale/listings";
import { sellerPayouts } from "@/server/resale/payouts";
import { cancelListingAction } from "../actions";

export const metadata = { title: "My listings" };

const PAYOUT_STATUS: Record<string, string> = {
  held: "Held until after the event",
  disputed: "On hold: the buyer reported a problem",
  paid: "Paid",
  cancelled: "Cancelled: the buyer was refunded",
};

export default async function MyListingsPage({ searchParams }: PageProps<"/resale/mine">) {
  const user = await requireUser("/resale/mine");
  const sp = await searchParams;
  const [rows, payouts] = await Promise.all([sellerListings(user.id), sellerPayouts(user.id)]);
  const payoutFor = new Map(payouts.map((p) => [p.listingId, p]));

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <PageHeader
        title="My Listings"
        subtitle="Tickets you're selling and what you'll be paid."
        actions={<ButtonLink href="/resale/sell"><Tag className="size-4" aria-hidden /> Sell a ticket</ButtonLink>}
      />
      <Flash sp={sp} />
      <div className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState icon={<Repeat className="size-6" />} title="You haven't listed any tickets" body="Can't make an event? List your ticket and get paid after the event." action={<ButtonLink href="/resale/sell">Sell a ticket</ButtonLink>} />
        ) : (
          rows
            .slice()
            .reverse()
            .map(({ listing, event }) => {
              const [label, tone] = LISTING_STATUS[listing.status];
              const payout = payoutFor.get(listing.id);
              const title = event?.title ?? listing.externalEventName ?? "Event";
              const when = event?.startsAt ?? listing.externalStartsAt;
              return (
                <Card key={listing.id} className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={tone}>{label}</Badge>
                        <ResaleTrustBadge kind={listing.kind} />
                      </div>
                      <p className="font-semibold">{title}</p>
                      <p className="text-sm text-muted">
                        {listing.ticketTypeName}
                        {when ? ` · ${formatDateTime(when, event?.timezone)}` : ""} · <span className="font-mono text-xs">{listing.reference}</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold tabular-nums">{formatMoney(listing.priceMinor)}</p>
                      <p className="text-xs text-muted">to {formatPhone(listing.payoutPhone)}</p>
                    </div>
                  </div>
                  {listing.status === "rejected" && listing.reviewNote && <p className="rounded-2xl bg-danger/8 p-3 text-sm text-danger">{listing.reviewNote}</p>}
                  {payout && (
                    <p className="rounded-2xl bg-surface-2 p-3 text-sm">
                      <span className="font-semibold">Payout:</span> {PAYOUT_STATUS[payout.status]}
                      {payout.status === "held" && ` (from ${formatDateTime(payout.releaseAt, event?.timezone)})`}
                      {payout.status === "paid" && payout.payoutReference && ` · M-Pesa ${payout.payoutReference}`}
                    </p>
                  )}
                  {(listing.status === "active" || listing.status === "pending_review") && (
                    <div className="flex flex-wrap gap-2">
                      {listing.status === "active" && <ButtonLink href={`/resale/${listing.reference}`} variant="secondary" size="sm">View listing</ButtonLink>}
                      <form action={cancelListingAction}>
                        <input type="hidden" name="listingId" value={listing.id} />
                        <SubmitButton variant="ghost" size="sm">Withdraw from listings</SubmitButton>
                      </form>
                    </div>
                  )}
                </Card>
              );
            })
        )}
      </div>
      <p className="mt-8 text-center text-xs text-subtle">
        Questions about a payout? <a href={`mailto:${env.supportEmail}`} className="underline">Contact support</a> with your listing reference.
      </p>
    </div>
  );
}

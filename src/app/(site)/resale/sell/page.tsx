import { ArrowRight, Globe, Ticket } from "lucide-react";
import { EventImage } from "@/components/events/event-image";
import { ButtonLink, Card, EmptyState, PageHeader } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";
import { resellableTickets } from "@/server/resale/listings";
import { PlatformListingForm } from "../forms";

export const metadata = { title: "Sell a ticket" };

export default async function SellTicketPage() {
  const user = await requireUser("/resale/sell");
  const rows = await resellableTickets(user.id);
  const phone = user.phone ? formatPhone(user.phone) : "";

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <PageHeader title="Sell a ticket" subtitle="Set your price. You get the full amount on M-Pesa after the event; buyers pay a 10% fee on top." />

      <section className="space-y-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Ticket className="size-5 text-teal" aria-hidden /> Your TikoSoko tickets</h2>
        {rows.length === 0 ? (
          <EmptyState icon={<Ticket className="size-6" />} title="No tickets to resell" body="Valid, unused tickets for upcoming events booked with this account show up here." />
        ) : (
          rows.map((r) => (
            <Card key={r.ticketId} className="space-y-4 p-4">
              <div className="flex items-center gap-4">
                <EventImage src={r.event.coverImageUrl} alt="" width={200} sizes="64px" className="size-16 shrink-0 rounded-2xl" />
                <div className="min-w-0">
                  <p className="text-xs text-muted">{formatDateTime(r.event.startsAt, r.event.timezone)}</p>
                  <p className="line-clamp-1 font-semibold">{r.event.title}</p>
                  <p className="text-sm text-muted">
                    {r.typeName} · paid {formatMoney(r.unitPriceMinor)} · <span className="font-mono text-xs">{r.code}</span>
                  </p>
                </div>
              </div>
              <PlatformListingForm ticketId={r.ticketId} defaultPhone={phone} faceValueMinor={r.unitPriceMinor || 100_00} />
            </Card>
          ))
        )}
      </section>

      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-sun text-[#2a1d00]"><Globe className="size-5" aria-hidden /></span>
          <div>
            <p className="font-semibold">Bought your ticket somewhere else?</p>
            <p className="text-sm text-muted">Sell tickets from Mookh, Ticketsasa or the organizer. Our team reviews each one before it goes live.</p>
          </div>
        </div>
        <ButtonLink href="/resale/sell/outside" variant="secondary" className="shrink-0">
          Sell an outside ticket <ArrowRight className="size-4" aria-hidden />
        </ButtonLink>
      </Card>
    </div>
  );
}

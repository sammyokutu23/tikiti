import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye, ScanLine, Sparkles, Users } from "lucide-react";
import { Flash } from "@/components/dash/flash";
import { FinanceBreakdown } from "@/components/dash/finance";
import { Alert, Badge, ButtonLink, Card, PageHeader, Section, Stat, StatusBadge, Textarea } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime, utcToZonedLocal } from "@/lib/dates";
import { NotFoundError } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import { eventCoordinates } from "@/lib/location";
import { canPublish, requireOrganizer, requireOwnedEvent } from "@/server/auth/guards";
import { ticketTypesForEvent } from "@/server/events/queries";
import { eventSalesStats } from "@/server/organizers/reports";
import { cancelEventAction, publishAction, ticketTypeOpAction } from "@/app/organizer/actions";
import { EventForm, TicketTypeForm } from "@/app/organizer/event-forms";

export const metadata = { title: "Manage event" };

export default async function ManageEventPage({ params, searchParams }: PageProps<"/organizer/events/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(id, ctx).catch((e) => {
    if (e instanceof NotFoundError) notFound();
    throw e;
  });
  const [types, stats] = await Promise.all([ticketTypesForEvent(ev.id), eventSalesStats(ev.id)]);
  const publishable = canPublish(ctx.user, ctx.organizer);
  const tz = ev.timezone;
  const local = (d: Date | null) => (d ? utcToZonedLocal(d, tz) : "");

  return (
    <div className="space-y-8">
      <PageHeader
        back={<Link href="/organizer/events" className="text-sm text-muted hover:text-fg">← Events</Link>}
        title={ev.title}
        subtitle={`${formatDateTime(ev.startsAt, tz)} · ${ev.venueName}, ${ev.city}`}
        actions={
          <>
            <ButtonLink href={`/organizer/events/${ev.id}/banner`} variant="secondary" size="sm"><Sparkles className="size-4" aria-hidden />AI banner</ButtonLink>
            <ButtonLink href={`/organizer/events/${ev.id}/preview`} variant="secondary" size="sm"><Eye className="size-4" aria-hidden />Preview</ButtonLink>
            <ButtonLink href={`/organizer/events/${ev.id}/attendees`} variant="secondary" size="sm"><Users className="size-4" aria-hidden />Attendees</ButtonLink>
            <ButtonLink href={`/organizer/events/${ev.id}/scan`} size="sm"><ScanLine className="size-4" aria-hidden />Scan tickets</ButtonLink>
          </>
        }
      />
      <Flash sp={sp} />

      {!eventCoordinates(ev) && ev.status !== "cancelled" && (
        <Alert tone="warning" title="No map pin yet">
          Buyers won&apos;t see a map or a precise Get directions link, and the event can&apos;t be published until you set and confirm a pin under Event details → Venue &amp; location.
        </Alert>
      )}

      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={ev.status} />
            {ev.isHidden && <Badge tone="danger">Hidden by moderation</Badge>}
          </div>
          <p className="text-sm text-muted">
            {ev.status === "draft" && (publishable ? "Only you can see this event. Publish it to start selling." : "Drafts can be published once your organizer account is verified.")}
            {ev.status === "published" && (ev.isHidden ? `Hidden by Tikiti moderation: ${ev.hiddenReason ?? ""}` : "Live — visible to the public and on sale.")}
            {ev.status === "cancelled" && `Cancelled: ${ev.cancellationReason ?? ""}`}
          </p>
        </div>
        {ev.status !== "cancelled" && (
          <form action={publishAction} className="shrink-0">
            <input type="hidden" name="eventId" value={ev.id} />
            {ev.status === "published" ? (
              <>
                <input type="hidden" name="op" value="unpublish" />
                <ConfirmButton variant="secondary" message="Unpublish this event? It will disappear from public listings (existing tickets stay valid).">Unpublish</ConfirmButton>
              </>
            ) : (
              <SubmitButton disabled={!publishable} title={publishable ? undefined : "Requires a verified organizer account"}>Publish event</SubmitButton>
            )}
          </form>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tickets sold" value={`${stats.sold} / ${stats.capacity}`} />
        <Stat label="Held" value={stats.reserved} hint="Checkout holds & payment plans" />
        <Stat label="Checked in" value={stats.attendance.checkedIn} hint={`of ${stats.attendance.issued} valid tickets`} />
        <Stat label="Confirmed bookings" value={stats.bookings.confirmed} hint={`${stats.attendance.refunded} tickets refunded`} />
      </div>

      <Section title="Ticket types">
        {types.length === 0 && <Alert tone="info">Add at least one ticket type before publishing.</Alert>}
        <div className="space-y-3">
          {types.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{t.name} {!t.isActive && <Badge className="ml-1">Inactive</Badge>}</p>
                  <p className="text-sm text-muted">
                    {formatMoney(t.priceMinor)} · {t.sold} sold · {t.reserved} held · {t.remaining} left of {t.capacity}
                  </p>
                  <p className="text-xs text-subtle">
                    {t.salesStartAt ? `Sales start ${formatDateTime(t.salesStartAt, tz)}` : "On sale when published"}
                    {t.salesEndAt ? ` · end ${formatDateTime(t.salesEndAt, tz)}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <form action={ticketTypeOpAction}>
                    <input type="hidden" name="eventId" value={ev.id} />
                    <input type="hidden" name="ticketTypeId" value={t.id} />
                    <input type="hidden" name="op" value={t.isActive ? "deactivate" : "activate"} />
                    <SubmitButton variant="ghost" size="sm">{t.isActive ? "Pause sales" : "Resume sales"}</SubmitButton>
                  </form>
                  <form action={ticketTypeOpAction}>
                    <input type="hidden" name="eventId" value={ev.id} />
                    <input type="hidden" name="ticketTypeId" value={t.id} />
                    <input type="hidden" name="op" value="remove" />
                    <ConfirmButton variant="ghost" size="sm" message={`Remove “${t.name}”? If it has bookings it will be deactivated instead.`}>Remove</ConfirmButton>
                  </form>
                </div>
              </div>
              {ev.status !== "cancelled" && (
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm text-muted hover:text-fg">Edit</summary>
                  <div className="mt-4">
                    <TicketTypeForm
                      eventId={ev.id}
                      ticketTypeId={t.id}
                      submitLabel="Save ticket type"
                      defaults={{
                        name: t.name,
                        description: t.description,
                        price: String(t.priceMinor / 100),
                        capacity: String(t.capacity),
                        maxPerOrder: String(t.maxPerOrder),
                        salesStartLocal: local(t.salesStartAt),
                        salesEndLocal: local(t.salesEndAt),
                      }}
                    />
                    <p className="mt-2 text-xs text-subtle">Price changes apply to new orders only — existing bookings keep the price they paid.</p>
                  </div>
                </details>
              )}
            </Card>
          ))}
          {ev.status !== "cancelled" && (
            <Card className="p-5">
              <h3 className="mb-4 font-semibold">Add a ticket type</h3>
              <TicketTypeForm eventId={ev.id} submitLabel="Add ticket type" />
            </Card>
          )}
          <p className="text-xs text-subtle">
            General admission. Reserved seating (seat maps and per-seat holds) is not yet available.
          </p>
        </div>
      </Section>

      <Section title="Sales & earnings">
        <FinanceBreakdown f={stats.finance} />
      </Section>

      <Section title="Event details">
        <Card className="p-5 sm:p-6">
          {ev.status === "cancelled" ? (
            <p className="text-sm text-muted">Cancelled events can&apos;t be edited.</p>
          ) : (
            <EventForm
              eventId={ev.id}
              defaults={{
                title: ev.title,
                summary: ev.summary,
                description: ev.description,
                category: ev.category,
                venueName: ev.venueName,
                venueAddress: ev.venueAddress,
                city: ev.city,
                timezone: ev.timezone,
                startsLocal: local(ev.startsAt),
                endsLocal: local(ev.endsAt),
                refundPolicy: ev.refundPolicy,
                installmentsEnabled: ev.installmentsEnabled ? "on" : "",
                coverImageUrl: ev.coverImageUrl ?? "",
                arrivalInstructions: ev.arrivalInstructions,
                latitude: ev.latitude === null ? "" : String(ev.latitude),
                longitude: ev.longitude === null ? "" : String(ev.longitude),
                locationProvider: ev.locationProvider ?? "",
                locationPlaceId: ev.locationPlaceId ?? "",
                locationConfirmed: ev.latitude === null ? "" : "1",
              }}
            />
          )}
        </Card>
      </Section>

      {ev.status !== "cancelled" && (
        <Section title="Danger zone">
          <Card className="space-y-4 border-danger/30 p-5">
            <p className="text-sm text-muted">
              Cancelling refunds every confirmed booking in full, invalidates all tickets, releases pending reservations and emails every buyer. This can&apos;t be undone.
            </p>
            <form action={cancelEventAction} className="space-y-3">
              <input type="hidden" name="eventId" value={ev.id} />
              <label htmlFor="reason" className="text-sm font-medium">Reason shown to buyers</label>
              <Textarea id="reason" name="reason" rows={2} placeholder="e.g. The venue is unavailable due to flooding." required />
              <ConfirmButton variant="danger" message="Cancel this event and refund all bookings?">Cancel event &amp; refund everyone</ConfirmButton>
            </form>
          </Card>
        </Section>
      )}
    </div>
  );
}

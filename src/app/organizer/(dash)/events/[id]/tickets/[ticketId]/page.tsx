import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookingItems, bookings, checkIns, tickets, users } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Card, PageHeader, StatusBadge, Table, Input } from "@/components/ui";
import { ConfirmButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { organizerEventPage } from "@/server/organizers/access";
import { revokeTicketAction } from "@/app/organizer/actions";

export const metadata = { title: "Ticket" };

export default async function TicketInspectPage({ params, searchParams }: PageProps<"/organizer/events/[id]/tickets/[ticketId]">) {
  const { id, ticketId } = await params;
  const sp = await searchParams;
  const { event } = await organizerEventPage(id);
  if (!/^[0-9a-f-]{36}$/.test(ticketId)) notFound();
  const [row] = await db
    .select({ t: tickets, b: bookings, item: bookingItems })
    .from(tickets)
    .innerJoin(bookings, eq(bookings.id, tickets.bookingId))
    .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
    .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, event.id)));
  if (!row) notFound();
  const scans = await db
    .select({ c: checkIns, scanner: users.name })
    .from(checkIns)
    .innerJoin(users, eq(users.id, checkIns.scannedBy))
    .where(eq(checkIns.ticketId, ticketId))
    .orderBy(desc(checkIns.createdAt));
  const tz = event.timezone;

  return (
    <div className="space-y-6">
      <PageHeader back={<Link href={`/organizer/events/${event.id}/attendees`} className="text-sm text-muted hover:text-fg">← Attendees</Link>} title={<span className="font-mono">{row.t.code}</span>} subtitle={`${row.item.ticketTypeName} · ${event.title}`} />
      <Flash sp={sp} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-5 text-sm">
          <div className="flex items-center gap-2"><StatusBadge status={row.t.status} /><StatusBadge status={row.b.status} /></div>
          <p><span className="text-muted">Attendee:</span> {row.t.attendeeName ?? "—"}</p>
          <p><span className="text-muted">Buyer:</span> {row.b.buyerName} · {row.b.buyerEmail} · {formatPhone(row.b.buyerPhone)}</p>
          <p><span className="text-muted">Booking:</span> <span className="font-mono">{row.b.reference}</span> · {formatMoney(row.item.unitPriceMinor)}</p>
          <p><span className="text-muted">Issued:</span> {formatDateTime(row.t.createdAt, tz)}</p>
          {row.t.checkedInAt && <p><span className="text-muted">Checked in:</span> {formatDateTime(row.t.checkedInAt, tz)}</p>}
          {row.t.revokeReason && <p><span className="text-muted">Reason:</span> {row.t.revokeReason}</p>}
        </Card>
        {(row.t.status === "valid" || row.t.status === "checked_in") && (
          <Card className="space-y-3 p-5">
            <p className="text-sm font-semibold">Revoke ticket</p>
            <p className="text-xs text-muted">The ticket will be rejected at the gate. This does not refund the buyer — use Refund on the booking for that.</p>
            <form action={revokeTicketAction} className="space-y-3">
              <input type="hidden" name="ticketId" value={row.t.id} />
              <Input name="reason" placeholder="Reason (e.g. reported stolen)" />
              <ConfirmButton variant="danger" size="sm" message="Revoke this ticket?">Revoke ticket</ConfirmButton>
            </form>
          </Card>
        )}
      </div>
      <section className="space-y-3">
        <h2 className="font-semibold">Scan history</h2>
        {scans.length === 0 ? (
          <p className="text-sm text-muted">Not scanned yet.</p>
        ) : (
          <Table>
            <thead><tr><th>Time</th><th>Result</th><th>Scanned by</th></tr></thead>
            <tbody>{scans.map((s) => <tr key={s.c.id}><td>{formatDateTime(s.c.createdAt, tz)}</td><td><StatusBadge status={s.c.result} /></td><td>{s.scanner}</td></tr>)}</tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

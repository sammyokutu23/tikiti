import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { bookingItems, bookings, checkIns, events, tickets, users } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Card, EmptyState, Input, PageHeader, Section, StatusBadge, Table } from "@/components/ui";
import { ConfirmButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { parseScanInput } from "@/server/tickets/qr";
import { adminRevokeTicketAction } from "../actions";

export const metadata = { title: "Tickets & check-ins" };

export default async function AdminTickets({ searchParams }: PageProps<"/admin/tickets">) {
  const sp = await searchParams;
  const raw = typeof sp.code === "string" ? sp.code.slice(0, 300) : "";
  const parsed = raw ? parseScanInput(raw) : null;
  const ticket =
    parsed?.ok
      ? (
          await db
            .select({ t: tickets, b: bookings, e: events, type: bookingItems.ticketTypeName })
            .from(tickets)
            .innerJoin(bookings, eq(bookings.id, tickets.bookingId))
            .innerJoin(events, eq(events.id, tickets.eventId))
            .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
            .where(eq(tickets.code, parsed.code))
        )[0]
      : undefined;
  const scans = ticket
    ? await db.select({ c: checkIns, by: users.email }).from(checkIns).innerJoin(users, eq(users.id, checkIns.scannedBy)).where(eq(checkIns.ticketId, ticket.t.id)).orderBy(desc(checkIns.createdAt))
    : [];
  const recent = await db
    .select({ c: checkIns, by: users.email, title: events.title })
    .from(checkIns)
    .innerJoin(users, eq(users.id, checkIns.scannedBy))
    .innerJoin(events, eq(events.id, checkIns.eventId))
    .orderBy(desc(checkIns.createdAt))
    .limit(40);

  return (
    <div className="space-y-8">
      <PageHeader title="Ticket investigations" subtitle="Look up a ticket by code or scanned QR payload and review its scan history." />
      <Flash sp={sp} />
      <form className="flex max-w-xl gap-2">
        <Input name="code" defaultValue={raw} placeholder="Ticket code or QR payload" className="font-mono" aria-label="Ticket code" />
        <button className="rounded-full bg-primary px-5 text-sm font-semibold text-primary-fg">Look up</button>
      </form>
      {raw && !ticket && <EmptyState title="No ticket found" body={parsed && !parsed.ok ? `Input rejected: ${parsed.reason.replace("_", " ")}` : "Check the code and try again."} />}
      {ticket && (
        <Card className="space-y-3 p-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><span className="font-mono text-base">{ticket.t.code}</span><StatusBadge status={ticket.t.status} /><StatusBadge status={ticket.b.status} /></div>
          <p>{ticket.type} · {ticket.e.title} · {formatDateTime(ticket.e.startsAt, ticket.e.timezone)}</p>
          <p className="text-muted">Booking <Link href={`/admin/bookings/${ticket.b.id}`} className="font-mono underline">{ticket.b.reference}</Link> · {ticket.b.buyerName} ({ticket.b.buyerEmail})</p>
          {ticket.t.revokeReason && <p className="text-muted">Reason: {ticket.t.revokeReason}</p>}
          {(ticket.t.status === "valid" || ticket.t.status === "checked_in") && (
            <form action={adminRevokeTicketAction} className="flex max-w-md gap-2">
              <input type="hidden" name="ticketId" value={ticket.t.id} />
              <input type="hidden" name="back" value={`/admin/tickets?code=${ticket.t.code}`} />
              <Input name="reason" placeholder="Reason" />
              <ConfirmButton variant="danger" size="sm" message="Revoke this ticket?">Revoke</ConfirmButton>
            </form>
          )}
          <Table>
            <thead><tr><th>Time</th><th>Result</th><th>Scanner</th></tr></thead>
            <tbody>{scans.length === 0 ? <tr><td colSpan={3} className="text-muted">Never scanned.</td></tr> : scans.map((s) => <tr key={s.c.id}><td>{formatDateTime(s.c.createdAt)}</td><td><StatusBadge status={s.c.result} /></td><td>{s.by}</td></tr>)}</tbody>
          </Table>
        </Card>
      )}
      <Section title="Recent scans (all events)">
        <Table>
          <thead><tr><th>Time</th><th>Event</th><th>Result</th><th>Code / input</th><th>Scanner</th></tr></thead>
          <tbody>{recent.length === 0 ? <tr><td colSpan={5} className="text-muted">No scans yet.</td></tr> : recent.map((s) => <tr key={s.c.id}><td className="text-xs">{formatDateTime(s.c.createdAt)}</td><td className="max-w-48 truncate">{s.title}</td><td><StatusBadge status={s.c.result} /></td><td className="max-w-40 truncate font-mono text-xs">{s.c.rawCode}</td><td className="text-xs">{s.by}</td></tr>)}</tbody>
        </Table>
      </Section>
    </div>
  );
}

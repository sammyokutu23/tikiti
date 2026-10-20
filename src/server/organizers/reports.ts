import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookingItems, bookings, events, tickets, ticketTypes } from "@/db/schema";
import { financialSummary } from "../ledger";

/** Organizer-wide overview. Always scoped to the organizer's own events. */
export async function organizerOverview(organizerId: string) {
  const evs = await db.select({ id: events.id }).from(events).where(eq(events.organizerId, organizerId));
  const ids = evs.map((e) => e.id);
  const finance = await financialSummary({ organizerId });
  if (ids.length === 0) {
    return { finance, ticketsSold: 0, remaining: 0, checkedIn: 0, issued: 0, recent: [] as RecentBooking[] };
  }
  const [inv] = await db
    .select({
      sold: sql<number>`coalesce(sum(${ticketTypes.sold}),0)::int`,
      remaining: sql<number>`coalesce(sum(${ticketTypes.capacity} - ${ticketTypes.sold} - ${ticketTypes.reserved}) filter (where ${ticketTypes.isActive}),0)::int`,
    })
    .from(ticketTypes)
    .where(inArray(ticketTypes.eventId, ids));
  const [att] = await db
    .select({
      issued: sql<number>`count(*) filter (where ${tickets.status} in ('valid','checked_in'))::int`,
      checkedIn: sql<number>`count(*) filter (where ${tickets.status} = 'checked_in')::int`,
    })
    .from(tickets)
    .where(inArray(tickets.eventId, ids));
  return {
    finance,
    ticketsSold: inv.sold,
    remaining: inv.remaining,
    issued: att.issued,
    checkedIn: att.checkedIn,
    recent: await recentBookings({ eventIds: ids, limit: 8 }),
  };
}

export type RecentBooking = Awaited<ReturnType<typeof recentBookings>>[number];

export async function recentBookings(args: { eventIds: string[]; limit?: number; q?: string; status?: string }) {
  if (args.eventIds.length === 0) return [];
  // Fan-to-fan resales aren't organizer sales; the reissued ticket still shows under attendees.
  const conds = [inArray(bookings.eventId, args.eventIds), isNull(bookings.resaleListingId)];
  if (args.q?.trim()) {
    const t = `%${args.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(bookings.buyerName, t),
        ilike(bookings.buyerEmail, t),
        ilike(bookings.reference, t),
        sql`exists (select 1 from ${tickets} where ${tickets.bookingId} = ${bookings.id} and ${tickets.code} ilike ${t})`,
      )!,
    );
  }
  if (args.status) conds.push(eq(bookings.status, args.status as never));
  return db
    .select({
      id: bookings.id,
      reference: bookings.reference,
      buyerName: bookings.buyerName,
      buyerEmail: bookings.buyerEmail,
      buyerPhone: bookings.buyerPhone,
      status: bookings.status,
      paymentStatus: bookings.paymentStatus,
      totalMinor: bookings.totalMinor,
      commissionMinor: bookings.commissionMinor,
      createdAt: bookings.createdAt,
      eventTitle: events.title,
      eventId: events.id,
      quantity: sql<number>`(select coalesce(sum(${bookingItems.quantity}),0)::int from ${bookingItems} where ${bookingItems.bookingId} = ${bookings.id})`,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(and(...conds))
    .orderBy(desc(bookings.createdAt))
    .limit(args.limit ?? 100);
}

export async function eventSalesStats(eventId: string) {
  const types = await db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId));
  const [att] = await db
    .select({
      issued: sql<number>`count(*) filter (where ${tickets.status} in ('valid','checked_in'))::int`,
      checkedIn: sql<number>`count(*) filter (where ${tickets.status} = 'checked_in')::int`,
      refunded: sql<number>`count(*) filter (where ${tickets.status} = 'refunded')::int`,
      revoked: sql<number>`count(*) filter (where ${tickets.status} = 'revoked')::int`,
    })
    .from(tickets)
    .where(eq(tickets.eventId, eventId));
  const [bk] = await db
    .select({
      confirmed: sql<number>`count(*) filter (where ${bookings.status} = 'confirmed')::int`,
      pending: sql<number>`count(*) filter (where ${bookings.status} = 'pending')::int`,
    })
    .from(bookings)
    .where(and(eq(bookings.eventId, eventId), isNull(bookings.resaleListingId)));
  return {
    types,
    sold: types.reduce((s, t) => s + t.sold, 0),
    reserved: types.reduce((s, t) => s + t.reserved, 0),
    capacity: types.reduce((s, t) => s + t.capacity, 0),
    attendance: att,
    bookings: bk,
    finance: await financialSummary({ eventIds: [eventId] }),
  };
}

export async function attendeesForEvent(eventId: string, q?: string) {
  const conds = [eq(tickets.eventId, eventId)];
  if (q?.trim()) {
    const t = `%${q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(ilike(tickets.code, t), ilike(tickets.attendeeName, t), ilike(bookings.buyerEmail, t), ilike(bookings.buyerName, t), ilike(bookings.reference, t))!,
    );
  }
  return db
    .select({
      id: tickets.id,
      code: tickets.code,
      status: tickets.status,
      attendeeName: tickets.attendeeName,
      checkedInAt: tickets.checkedInAt,
      ticketType: bookingItems.ticketTypeName,
      reference: bookings.reference,
      buyerName: bookings.buyerName,
      buyerEmail: bookings.buyerEmail,
      buyerPhone: bookings.buyerPhone,
      bookingId: bookings.id,
    })
    .from(tickets)
    .innerJoin(bookings, eq(bookings.id, tickets.bookingId))
    .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
    .where(and(...conds))
    .orderBy(bookings.buyerName, tickets.sequence)
    .limit(1000);
}

export function attendeesCsv(rows: Awaited<ReturnType<typeof attendeesForEvent>>) {
  const cell = (v: unknown) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // spreadsheet formula injection guard
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Ticket code", "Ticket type", "Status", "Attendee", "Buyer name", "Buyer email", "Buyer phone", "Booking reference", "Checked in at (UTC)"];
  const lines = rows.map((r) =>
    [r.code, r.ticketType, r.status, r.attendeeName, r.buyerName, r.buyerEmail, r.buyerPhone, r.reference, r.checkedInAt?.toISOString() ?? ""]
      .map(cell)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

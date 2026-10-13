import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { bookingItems, bookings, events, organizerProfiles, tickets } from "@/db/schema";
import { env } from "@/lib/env";
import { slugify } from "@/lib/utils";
import { renderTicketsPdf, type TicketPdfData } from "../pdf/ticket-pdf";
import { buildQrPayload } from "./qr";

/** Loads everything needed to render a booking's tickets (optionally a subset). */
export async function loadTicketPdfData(bookingId: string, ticketIds?: string[]): Promise<{
  data: TicketPdfData[];
  eventSlug: string;
  reference: string;
}> {
  const [row] = await db
    .select({ booking: bookings, event: events, organizerName: organizerProfiles.displayName })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(bookings.id, bookingId));
  if (!row) throw new Error("Booking not found");

  const rows = await db
    .select({ ticket: tickets, item: bookingItems })
    .from(tickets)
    .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
    .where(
      ticketIds?.length
        ? and(eq(tickets.bookingId, bookingId), inArray(tickets.id, ticketIds))
        : eq(tickets.bookingId, bookingId),
    )
    .orderBy(asc(bookingItems.ticketTypeName), asc(tickets.sequence));

  const total = await db.$count(tickets, eq(tickets.bookingId, bookingId));
  const allIds = (
    await db
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
      .where(eq(tickets.bookingId, bookingId))
      .orderBy(asc(bookingItems.ticketTypeName), asc(tickets.sequence))
  ).map((r) => r.id);

  const pageUrl = `${env.appUrl}/bookings/find`;

  const data: TicketPdfData[] = rows.map(({ ticket, item }) => ({
    code: ticket.code,
    qrPayload: buildQrPayload(ticket.code),
    sequenceLabel: `Ticket ${allIds.indexOf(ticket.id) + 1} of ${total}`,
    ticketType: item.ticketTypeName,
    priceMinor: item.unitPriceMinor,
    currency: row.booking.currency,
    attendeeName: ticket.attendeeName,
    bookingReference: row.booking.reference,
    status: ticket.status,
    event: {
      title: row.event.title,
      category: row.event.category,
      startsAt: row.event.startsAt,
      endsAt: row.event.endsAt,
      timezone: row.event.timezone,
      venueName: row.event.venueName,
      venueAddress: row.event.venueAddress,
      city: row.event.city,
      coverImageUrl: row.event.coverImageUrl,
      organizerName: row.organizerName,
      latitude: row.event.latitude,
      longitude: row.event.longitude,
      arrivalInstructions: row.event.arrivalInstructions,
    },
    supportEmail: env.supportEmail,
    ticketPageUrl: pageUrl,
  }));
  return { data, eventSlug: row.event.slug, reference: row.booking.reference };
}

export async function renderBookingPdf(bookingId: string, opts: { createdAt?: Date } = {}) {
  const { data, eventSlug, reference } = await loadTicketPdfData(bookingId);
  const bytes = await renderTicketsPdf(data, opts);
  return {
    bytes,
    filename: `tikiti-${slugify(eventSlug).slice(0, 40)}-${reference}.pdf`,
    count: data.length,
    tickets: data.map((t) => ({ ticketType: t.ticketType, attendeeName: t.attendeeName, label: t.sequenceLabel, status: t.status })),
  };
}

export async function renderSingleTicketPdf(bookingId: string, ticketId: string) {
  const { data, eventSlug } = await loadTicketPdfData(bookingId, [ticketId]);
  if (data.length !== 1) throw new Error("Ticket not found");
  const bytes = await renderTicketsPdf(data);
  return { bytes, filename: `tikiti-${slugify(eventSlug).slice(0, 40)}-${data[0].code}.pdf` };
}

export function pdfResponse(bytes: Uint8Array, filename: string, disposition: "attachment" | "inline" = "attachment") {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${disposition}; filename="${filename}"`,
      "Content-Length": String(bytes.length),
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

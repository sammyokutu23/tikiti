import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, checkIns, events, ticketTypes, tickets } from "@/db/schema";
import { parseScanInput } from "./qr";

export type ScanOutcome =
  | "accepted"
  | "already_checked_in"
  | "revoked"
  | "refunded"
  | "invalid"
  | "wrong_event"
  | "not_confirmed";

export type ScanResponse = {
  result: ScanOutcome;
  message: string;
  ticket?: {
    code: string;
    ticketType: string;
    attendeeName: string | null;
    bookingReference: string;
    checkedInAt: string | null;
  };
};

const MESSAGES: Record<ScanOutcome, string> = {
  accepted: "Valid ticket — admit",
  already_checked_in: "Already checked in",
  revoked: "Ticket revoked — do not admit",
  refunded: "Ticket refunded — do not admit",
  invalid: "Invalid ticket",
  wrong_event: "Ticket is for a different event",
  not_confirmed: "Booking not confirmed",
};

/**
 * Validates and (if valid) checks in a ticket for `eventId`. The caller MUST
 * have verified that `scannerUserId` is authorized to scan for this event.
 * The ticket row is locked so two simultaneous scans cannot both be accepted.
 */
export async function scanTicket(args: { raw: string; eventId: string; scannerUserId: string }): Promise<ScanResponse> {
  const parsed = parseScanInput(args.raw);
  const rawForLog = args.raw.slice(0, 200);

  if (!parsed.ok) {
    await db.insert(checkIns).values({
      eventId: args.eventId,
      scannedBy: args.scannerUserId,
      result: "invalid",
      rawCode: rawForLog,
    });
    return { result: "invalid", message: MESSAGES.invalid };
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ ticket: tickets, booking: bookings, typeName: ticketTypes.name })
      .from(tickets)
      .innerJoin(bookings, eq(bookings.id, tickets.bookingId))
      .innerJoin(ticketTypes, eq(ticketTypes.id, tickets.ticketTypeId))
      .where(eq(tickets.code, parsed.code))
      .for("update", { of: tickets });

    const log = (result: ScanOutcome, ticketId?: string) =>
      tx.insert(checkIns).values({
        eventId: args.eventId,
        scannedBy: args.scannerUserId,
        result,
        ticketId: ticketId ?? null,
        rawCode: rawForLog,
      });

    if (!row) {
      await log("invalid");
      return { result: "invalid", message: MESSAGES.invalid } satisfies ScanResponse;
    }
    if (row.ticket.eventId !== args.eventId) {
      // Don't reveal details of another organizer's ticket.
      await log("wrong_event");
      return { result: "wrong_event", message: MESSAGES.wrong_event } satisfies ScanResponse;
    }

    const info = {
      code: row.ticket.code,
      ticketType: row.typeName,
      attendeeName: row.ticket.attendeeName,
      bookingReference: row.booking.reference,
      checkedInAt: row.ticket.checkedInAt?.toISOString() ?? null,
    };

    let result: ScanOutcome;
    if (row.ticket.status === "refunded") result = "refunded";
    else if (row.ticket.status === "revoked") result = "revoked";
    else if (row.booking.status !== "confirmed") result = "not_confirmed";
    else if (row.ticket.status === "checked_in") result = "already_checked_in";
    else result = "accepted";

    if (result === "accepted") {
      const now = new Date();
      await tx
        .update(tickets)
        .set({ status: "checked_in", checkedInAt: now, checkedInBy: args.scannerUserId })
        .where(and(eq(tickets.id, row.ticket.id), eq(tickets.status, "valid")));
      info.checkedInAt = now.toISOString();
    }
    await log(result, row.ticket.id);
    return { result, message: MESSAGES[result], ticket: info } satisfies ScanResponse;
  });
}

export async function attendanceStats(eventId: string) {
  const [r] = await db
    .select({
      issued: sql<number>`count(*) filter (where ${tickets.status} in ('valid','checked_in'))::int`,
      checkedIn: sql<number>`count(*) filter (where ${tickets.status} = 'checked_in')::int`,
    })
    .from(tickets)
    .where(eq(tickets.eventId, eventId));
  return r;
}

export async function eventIdForScanner(eventId: string) {
  const [e] = await db.select({ id: events.id, organizerId: events.organizerId }).from(events).where(eq(events.id, eventId));
  return e;
}

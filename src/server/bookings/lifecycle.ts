/**
 * Booking state machine.
 *
 *   pending ──(verified payment / free)──▶ confirmed ──(refund)──▶ refunded
 *      │                                       
 *      ├──(hold expires)──▶ expired ─┐  (late verified payment: re-acquire
 *      └──(customer cancels)──▶ cancelled ─┤   inventory → confirmed, or
 *                                          └──▶ failed + automatic refund)
 *
 * Callers must hold a row lock on the booking (lockBooking) before transitions.
 */
import { and, eq, lt } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  bookingItems,
  bookings,
  events,
  organizerProfiles,
  refunds,
  tickets,
  type Booking,
} from "@/db/schema";
import { newTicketCode } from "@/lib/crypto";
import {
  acquireSoldInventory,
  commitHeldInventory,
  InventoryUnavailableError,
  releaseHeldInventory,
  type InventoryLine,
} from "../inventory";
import { recordSaleLedger } from "../ledger";
import { queueOrganizerEmail } from "../email/notify";
import { queueEmail } from "../email/queue";
import { enqueueJob } from "../jobs/queue";
import { audit } from "../audit";

export async function lockBooking(tx: Tx, bookingId: string) {
  const [b] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
  return b ?? null;
}

export async function bookingLines(tx: Tx, bookingId: string): Promise<InventoryLine[]> {
  const items = await tx
    .select({ ticketTypeId: bookingItems.ticketTypeId, quantity: bookingItems.quantity })
    .from(bookingItems)
    .where(eq(bookingItems.bookingId, bookingId));
  return items;
}

async function organizerIdForEvent(tx: Tx, eventId: string) {
  const [e] = await tx.select({ organizerId: events.organizerId }).from(events).where(eq(events.id, eventId));
  return e.organizerId;
}

/**
 * Confirms a locked booking: commits inventory, issues one ticket per unit,
 * writes ledger entries and queues the confirmation email — all atomically.
 * Idempotent: confirming an already-confirmed booking is a no-op.
 * Throws InventoryUnavailableError when a late payment can't be honoured.
 */
export async function confirmBooking(tx: Tx, booking: Booking, opts: { free: boolean }): Promise<Booking> {
  if (booking.status === "confirmed") return booking;
  if (booking.status === "refunded" || booking.status === "failed") {
    throw new Error(`Cannot confirm booking in status ${booking.status}`);
  }
  const lines = await bookingLines(tx, booking.id);
  if (booking.inventoryState === "held") await commitHeldInventory(tx, lines);
  else if (booking.inventoryState === "released") await acquireSoldInventory(tx, lines);

  const now = new Date();
  const [updated] = await tx
    .update(bookings)
    .set({
      status: "confirmed",
      paymentStatus: opts.free ? "not_required" : "paid",
      inventoryState: "committed",
      confirmedAt: now,
      updatedAt: now,
    })
    .where(eq(bookings.id, booking.id))
    .returning();

  await issueTickets(tx, updated);
  await recordSaleLedger(tx, updated, await organizerIdForEvent(tx, updated.eventId));
  await queueEmail(tx, {
    kind: "booking_confirmation",
    bookingId: updated.id,
    toEmail: updated.buyerEmail,
    dedupeKey: `booking_confirmation:${updated.id}`,
  });
  await queueOrganizerEmail(tx, updated.eventId, "organizer_new_sale", { bookingId: updated.id, dedupeKey: `organizer_new_sale:${updated.id}` });
  await audit(tx, {
    action: "booking.confirmed",
    entityType: "booking",
    entityId: updated.id,
    metadata: { reference: updated.reference, totalMinor: updated.totalMinor, free: opts.free },
  });
  return updated;
}

/** One ticket per purchased unit; (booking_item_id, sequence) makes this idempotent. */
export async function issueTickets(tx: Tx, booking: Booking) {
  const items = await tx.select().from(bookingItems).where(eq(bookingItems.bookingId, booking.id));
  const rows = items.flatMap((item) =>
    Array.from({ length: item.quantity }, (_, i) => ({
      code: newTicketCode(),
      bookingId: booking.id,
      bookingItemId: item.id,
      sequence: i + 1,
      eventId: booking.eventId,
      ticketTypeId: item.ticketTypeId,
      attendeeName: booking.buyerName,
    })),
  );
  if (rows.length) {
    await tx.insert(tickets).values(rows).onConflictDoNothing({ target: [tickets.bookingItemId, tickets.sequence] });
  }
}

/** Expire pending bookings whose hold lapsed, releasing their inventory. */
export async function expireStaleBookings(now = new Date(), limit = 200): Promise<number> {
  const due = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.status, "pending"), lt(bookings.expiresAt, now)))
    .limit(limit);
  let count = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [b] = await tx
        .select()
        .from(bookings)
        .where(and(eq(bookings.id, id), eq(bookings.status, "pending"), lt(bookings.expiresAt, now)))
        .for("update", { skipLocked: true });
      if (!b) return false;
      if (b.inventoryState === "held") await releaseHeldInventory(tx, await bookingLines(tx, b.id));
      await tx
        .update(bookings)
        .set({ status: "expired", inventoryState: "released", updatedAt: new Date() })
        .where(eq(bookings.id, b.id));
      return true;
    });
    if (done) count++;
  }
  return count;
}

export async function cancelPendingBooking(tx: Tx, booking: Booking, reason: string) {
  if (booking.status !== "pending") return booking;
  if (booking.inventoryState === "held") await releaseHeldInventory(tx, await bookingLines(tx, booking.id));
  const [b] = await tx
    .update(bookings)
    .set({ status: "cancelled", inventoryState: "released", cancelledAt: new Date(), updatedAt: new Date() })
    .where(eq(bookings.id, booking.id))
    .returning();
  await audit(tx, { action: "booking.cancelled", entityType: "booking", entityId: b.id, metadata: { reason } });
  return b;
}

/**
 * A payment was verified but the booking can't be honoured (inventory gone).
 * Marks it failed and creates an automatic refund — never silently keeps money.
 */
export async function failBookingWithRefund(tx: Tx, booking: Booking, paymentId: string, amountMinor: number) {
  await tx
    .update(bookings)
    .set({ status: "failed", paymentStatus: "refund_pending", updatedAt: new Date() })
    .where(eq(bookings.id, booking.id));
  const [refund] = await tx
    .insert(refunds)
    .values({
      bookingId: booking.id,
      paymentTransactionId: paymentId,
      amountMinor,
      reason: "Payment received after tickets sold out — automatic refund",
    })
    .returning();
  await enqueueJob(tx, "refund.process", { refundId: refund.id }, { dedupeKey: `refund:${refund.id}` });
  await audit(tx, {
    action: "booking.failed_late_payment",
    entityType: "booking",
    entityId: booking.id,
    metadata: { refundId: refund.id, paymentId },
  });
  return refund;
}

export { InventoryUnavailableError };

export async function organizerOfBooking(bookingId: string) {
  const [r] = await db
    .select({ organizerId: events.organizerId, userId: organizerProfiles.userId })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(bookings.id, bookingId));
  return r;
}


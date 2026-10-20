/**
 * What happens to a resale when its booking changes state. Called from the
 * booking lifecycle (confirmBooking / refundBooking) inside its transaction,
 * with the booking row already locked.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { bookings, events, resaleListings, resalePayouts, tickets, users, type Booking } from "@/db/schema";
import { audit } from "../audit";
import { issueTickets } from "../bookings/lifecycle";
import { queueEmail } from "../email/queue";
import { InventoryUnavailableError } from "../inventory";
import { payoutReleaseAt } from "./policy";

/**
 * A buyer's payment for a resale was verified:
 *  - TikoSoko ticket: the seller's ticket is revoked and a new one (new code and QR)
 *    is issued to the buyer, so the seller's copy can no longer get anyone in.
 *  - Outside ticket: the buyer gets access to the file the seller uploaded.
 * The listing is marked sold and the seller's money is held until after the event.
 * Throws InventoryUnavailableError (→ automatic refund) if the ticket can't be
 * delivered: listing withdrawn, ticket used or refunded meanwhile, event over.
 */
export async function confirmResaleBooking(tx: Tx, booking: Booking): Promise<Booking> {
  const [l] = await tx.select().from(resaleListings).where(eq(resaleListings.id, booking.resaleListingId!)).for("update");
  const [ev] = await tx.select().from(events).where(eq(events.id, booking.eventId));
  const now = new Date();
  const unavailable = new InventoryUnavailableError("Sorry, this resale ticket is no longer available.");
  if (!l || l.status !== "active" || !ev || ev.status !== "published" || ev.endsAt <= now) throw unavailable;

  if (l.kind === "platform") {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, l.ticketId!)).for("update");
    if (!t || t.status !== "valid") throw unavailable;
    await tx
      .update(tickets)
      .set({ status: "revoked", revokedAt: now, revokeReason: `Resold on TikoSoko (${l.reference})` })
      .where(eq(tickets.id, t.id));
  }

  const [updated] = await tx
    .update(bookings)
    .set({ status: "confirmed", paymentStatus: "paid", confirmedAt: now, updatedAt: now })
    .where(eq(bookings.id, booking.id))
    .returning();
  if (l.kind === "platform") await issueTickets(tx, updated);

  await tx.update(resaleListings).set({ status: "sold", soldBookingId: updated.id, soldAt: now, updatedAt: now }).where(eq(resaleListings.id, l.id));
  const releaseAt = payoutReleaseAt(l.kind, ev.endsAt);
  await tx.insert(resalePayouts).values({
    listingId: l.id,
    bookingId: updated.id,
    sellerUserId: l.sellerUserId,
    amountMinor: l.priceMinor,
    currency: l.currency,
    payoutPhone: l.payoutPhone,
    releaseAt,
  });

  await queueEmail(tx, {
    kind: l.kind === "platform" ? "booking_confirmation" : "resale_purchase_confirmed",
    bookingId: updated.id,
    toEmail: updated.buyerEmail,
    dedupeKey: `${l.kind === "platform" ? "booking_confirmation" : "resale_purchase_confirmed"}:${updated.id}`,
  });
  const [seller] = await tx.select({ email: users.email }).from(users).where(eq(users.id, l.sellerUserId));
  await queueEmail(tx, {
    kind: "resale_sold",
    toEmail: seller?.email,
    userId: l.sellerUserId,
    dedupeKey: `resale_sold:${l.id}`,
    metadata: { listingId: l.id },
  });
  await audit(tx, {
    action: "resale.sold",
    entityType: "resale_listing",
    entityId: l.id,
    metadata: { reference: l.reference, bookingId: updated.id, priceMinor: l.priceMinor, feeMinor: updated.feesMinor, releaseAt: releaseAt.toISOString() },
  });
  return updated;
}

/** The resale booking was refunded: the seller's held payout is cancelled. */
export async function cancelResalePayout(tx: Tx, booking: Booking, actorUserId: string) {
  const cancelled = await tx
    .update(resalePayouts)
    .set({ status: "cancelled", note: "Buyer refunded", updatedAt: new Date() })
    .where(and(eq(resalePayouts.bookingId, booking.id), inArray(resalePayouts.status, ["held", "disputed"])))
    .returning({ id: resalePayouts.id });
  const [paid] = cancelled.length
    ? []
    : await tx.select({ id: resalePayouts.id }).from(resalePayouts).where(and(eq(resalePayouts.bookingId, booking.id), eq(resalePayouts.status, "paid")));
  await audit(tx, {
    actorUserId,
    action: paid ? "resale.refund_after_payout" : "resale.payout_cancelled",
    entityType: "booking",
    entityId: booking.id,
    metadata: { reference: booking.reference, payoutId: cancelled[0]?.id ?? paid?.id ?? null },
  });
}

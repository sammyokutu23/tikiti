/**
 * Seller payouts (escrow) and buyer disputes. Payouts are sent by an admin over
 * M-Pesa and recorded here; nothing in this module moves money by itself.
 */
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { bookings, events, resaleListings, resalePayouts, users } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { audit } from "../audit";
import { refundBooking } from "../bookings/refunds";

/** The buyer reports that a resale ticket didn't work; the seller's payout is paused for review. */
export async function disputeResale(bookingId: string, reason: string, actorUserId: string | null) {
  const text = reason.trim().slice(0, 1000);
  if (text.length < 10) throw new UserError("Tell us what went wrong (at least a sentence).");
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(resalePayouts).where(eq(resalePayouts.bookingId, bookingId)).for("update");
    if (!p) throw new UserError("This booking isn't a resale purchase.");
    if (p.status === "disputed") throw new UserError("You've already reported this ticket. Our team will contact you.");
    if (p.status !== "held" || p.releaseAt <= new Date()) throw new UserError("The window for reporting a problem with this ticket has closed. Contact support.");
    await tx.update(resalePayouts).set({ status: "disputed", disputeReason: text, disputedAt: new Date(), updatedAt: new Date() }).where(eq(resalePayouts.id, p.id));
    await audit(tx, { actorUserId, action: "resale.disputed", entityType: "resale_payout", entityId: p.id, metadata: { bookingId, reason: text.slice(0, 300) } });
  });
}

/** Admin decides a dispute in the seller's favour: the payout goes back to held (payable once released). */
export async function releaseDisputedPayout(payoutId: string, adminId: string, note: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(resalePayouts).where(eq(resalePayouts.id, payoutId)).for("update");
    if (!p || p.status !== "disputed") throw new UserError("Only disputed payouts can be released.");
    await tx.update(resalePayouts).set({ status: "held", note: note.trim().slice(0, 500) || "Dispute resolved for the seller", updatedAt: new Date() }).where(eq(resalePayouts.id, p.id));
    await audit(tx, { actorUserId: adminId, action: "resale.dispute_released", entityType: "resale_payout", entityId: p.id, metadata: { note } });
  });
}

/** Admin decides a dispute for the buyer: full refund of the resale booking (cancels the payout). */
export async function refundDisputedResale(payoutId: string, adminId: string, note: string) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(resalePayouts).where(eq(resalePayouts.id, payoutId)).for("update");
    if (!p || (p.status !== "disputed" && p.status !== "held")) throw new UserError("This payout can't be refunded to the buyer.");
    await refundBooking(tx, { bookingId: p.bookingId, actorUserId: adminId, reason: `Resale dispute upheld: ${note.trim().slice(0, 300) || "ticket didn't work"}`, returnInventory: false });
  });
}

/** Admin records an M-Pesa payout they sent to the seller. */
export async function markPayoutPaid(payoutId: string, receipt: string, adminId: string) {
  const ref = receipt.trim().toUpperCase();
  if (!/^[A-Z0-9]{8,14}$/.test(ref)) throw new UserError("Enter the M-Pesa receipt of the payout, e.g. SJK3H7QX2P.");
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(resalePayouts).where(eq(resalePayouts.id, payoutId)).for("update");
    if (!p || p.status !== "held") throw new UserError("Only held payouts can be marked paid.");
    if (p.releaseAt > new Date()) throw new UserError("This payout is still in escrow until after the event.");
    await tx.update(resalePayouts).set({ status: "paid", paidAt: new Date(), paidBy: adminId, payoutReference: ref, updatedAt: new Date() }).where(eq(resalePayouts.id, p.id));
    await audit(tx, { actorUserId: adminId, action: "resale.payout_paid", entityType: "resale_payout", entityId: p.id, metadata: { receipt: ref, amountMinor: p.amountMinor } });
  });
}

export async function adminPayouts(tab: "ready" | "held" | "disputed" | "paid") {
  const now = new Date();
  const where =
    tab === "ready"
      ? and(eq(resalePayouts.status, "held"), lte(resalePayouts.releaseAt, now))
      : tab === "held"
        ? eq(resalePayouts.status, "held")
        : tab === "disputed"
          ? eq(resalePayouts.status, "disputed")
          : inArray(resalePayouts.status, ["paid", "cancelled"]);
  return db
    .select({
      payout: resalePayouts,
      listingRef: resaleListings.reference,
      kind: resaleListings.kind,
      bookingRef: bookings.reference,
      buyerName: bookings.buyerName,
      buyerEmail: bookings.buyerEmail,
      eventTitle: events.title,
      sellerName: users.name,
      sellerEmail: users.email,
    })
    .from(resalePayouts)
    .innerJoin(resaleListings, eq(resaleListings.id, resalePayouts.listingId))
    .innerJoin(bookings, eq(bookings.id, resalePayouts.bookingId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(users, eq(users.id, resalePayouts.sellerUserId))
    .where(where)
    .orderBy(tab === "paid" ? desc(resalePayouts.updatedAt) : resalePayouts.releaseAt)
    .limit(300);
}

export async function payoutForBooking(bookingId: string) {
  const [p] = await db.select().from(resalePayouts).where(eq(resalePayouts.bookingId, bookingId));
  return p ?? null;
}

export async function sellerPayouts(userId: string) {
  return db.select().from(resalePayouts).where(eq(resalePayouts.sellerUserId, userId));
}

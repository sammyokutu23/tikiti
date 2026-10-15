import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { bookings, events, paymentTransactions, refunds, tickets } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { audit } from "../audit";
import { queueOrganizerEmail } from "../email/notify";
import { queueEmail } from "../email/queue";
import { releaseSoldInventory } from "../inventory";
import { enqueueJob } from "../jobs/queue";
import { recordRefundLedger } from "../ledger";
import { bookingLines, cancelPendingBooking, lockBooking } from "./lifecycle";
import { endPlan } from "../plans/apply";

/**
 * Full refund of a confirmed booking (prototype supports whole-booking refunds).
 * Tickets become "refunded" immediately so they can't be used for entry, the
 * ledger records the refund and commission reversal, and the provider refund
 * runs as a retryable job.
 */
export async function refundBooking(
  tx: Tx,
  args: { bookingId: string; actorUserId: string; reason: string; returnInventory: boolean; notify?: boolean },
) {
  const booking = await lockBooking(tx, args.bookingId);
  if (!booking) throw new UserError("Booking not found.");
  if (booking.status !== "confirmed") throw new UserError(`Only confirmed bookings can be refunded (status: ${booking.status}).`);

  const [event] = await tx.select().from(events).where(eq(events.id, booking.eventId));
  // A plan-paid booking has one succeeded payment per installment; each is refunded separately.
  const payments = await tx
    .select()
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.bookingId, booking.id), eq(paymentTransactions.status, "succeeded")))
    .orderBy(paymentTransactions.createdAt);

  const isFree = booking.totalMinor === 0;
  await tx
    .update(tickets)
    .set({ status: "refunded", revokedAt: new Date(), revokeReason: args.reason })
    .where(and(eq(tickets.bookingId, booking.id), inArray(tickets.status, ["valid", "checked_in"])));

  if (args.returnInventory) await releaseSoldInventory(tx, await bookingLines(tx, booking.id));

  await tx
    .update(bookings)
    .set({
      status: isFree ? "cancelled" : "refunded",
      paymentStatus: isFree ? "not_required" : "refund_pending",
      inventoryState: args.returnInventory ? "released" : "committed",
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, booking.id));

  let refundId: string | null = null;
  if (!isFree) {
    // Split the booking total across the payments that made it up (one row when paid in full).
    const parts = payments.length > 1 ? payments.map((p) => ({ paymentId: p.id, amountMinor: p.amountMinor })) : [{ paymentId: payments[0]?.id ?? null, amountMinor: booking.totalMinor }];
    for (const [i, part] of parts.entries()) {
      const [refund] = await tx
        .insert(refunds)
        .values({
          bookingId: booking.id,
          paymentTransactionId: part.paymentId,
          amountMinor: part.amountMinor,
          commissionReversedMinor: i === 0 ? booking.commissionMinor : 0,
          reason: args.reason,
          initiatedBy: args.actorUserId,
        })
        .returning();
      if (i === 0) {
        refundId = refund.id;
        await recordRefundLedger(tx, {
          booking,
          organizerId: event.organizerId,
          refundId: refund.id,
          amountMinor: booking.subtotalMinor,
          commissionReversedMinor: booking.commissionMinor,
        });
      }
      await enqueueJob(tx, "refund.process", { refundId: refund.id }, { dedupeKey: `refund:${refund.id}` });
    }
  }

  if (args.notify !== false) {
    await queueEmail(tx, {
      kind: event.status === "cancelled" ? "event_cancelled" : "booking_refunded",
      bookingId: booking.id,
      toEmail: booking.buyerEmail,
      dedupeKey: `${event.status === "cancelled" ? "event_cancelled" : "booking_refunded"}:${booking.id}`,
    });
  }
  await audit(tx, {
    actorUserId: args.actorUserId,
    action: isFree ? "booking.cancelled_free" : "booking.refunded",
    entityType: "booking",
    entityId: booking.id,
    metadata: { reference: booking.reference, reason: args.reason, refundId, amountMinor: booking.totalMinor },
  });
  return { refundId };
}

/** Revoke one ticket (e.g. fraud/transfer issue) without refunding. */
export async function revokeTicket(args: { ticketId: string; actorUserId: string; reason: string }) {
  return db.transaction(async (tx) => {
    const [t] = await tx.select().from(tickets).where(eq(tickets.id, args.ticketId)).for("update");
    if (!t) throw new UserError("Ticket not found.");
    if (t.status === "refunded" || t.status === "revoked") return t;
    const [u] = await tx
      .update(tickets)
      .set({ status: "revoked", revokedAt: new Date(), revokeReason: args.reason })
      .where(eq(tickets.id, t.id))
      .returning();
    await audit(tx, {
      actorUserId: args.actorUserId,
      action: "ticket.revoked",
      entityType: "ticket",
      entityId: t.id,
      metadata: { code: t.code, reason: args.reason },
    });
    return u;
  });
}

/**
 * Cancels an event after sales: every confirmed booking is refunded (tickets
 * invalidated), every pending hold is released, and buyers are notified.
 */
export async function cancelEvent(args: { eventId: string; actorUserId: string; reason: string }) {
  return db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, args.eventId)).for("update");
    if (!event) throw new UserError("Event not found.");
    if (event.status === "cancelled") throw new UserError("Event is already cancelled.");
    await tx
      .update(events)
      .set({ status: "cancelled", cancelledAt: new Date(), cancellationReason: args.reason, updatedAt: new Date() })
      .where(eq(events.id, event.id));

    const affected = await tx
      .select({ id: bookings.id, status: bookings.status })
      .from(bookings)
      .where(and(eq(bookings.eventId, event.id), inArray(bookings.status, ["confirmed", "pending", "on_plan"])));

    let refunded = 0;
    for (const b of affected) {
      if (b.status === "pending") {
        const locked = await lockBooking(tx, b.id);
        if (locked) await cancelPendingBooking(tx, locked, "event_cancelled");
      } else if (b.status === "on_plan") {
        // Installment plan in progress: release the tickets and refund everything paid (no fee).
        await lockBooking(tx, b.id);
        await endPlan(tx, b.id, "event_cancelled", args.actorUserId);
        refunded++;
      } else {
        await refundBooking(tx, {
          bookingId: b.id,
          actorUserId: args.actorUserId,
          reason: `Event cancelled: ${args.reason}`,
          returnInventory: false,
        });
        refunded++;
      }
    }
    await audit(tx, {
      actorUserId: args.actorUserId,
      action: "event.cancelled",
      entityType: "event",
      entityId: event.id,
      metadata: { reason: args.reason, refundedBookings: refunded },
    });
    await queueOrganizerEmail(tx, event.id, "organizer_event_cancelled", {
      dedupeKey: `organizer_event_cancelled:${event.id}`,
      metadata: { reason: args.reason.slice(0, 300), bookingCount: refunded },
    });
    return { refunded };
  });
}

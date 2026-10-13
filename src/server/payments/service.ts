import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { bookings, paymentEvents, paymentTransactions, refunds, type Booking } from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { isUniqueViolation, UserError } from "@/lib/errors";
import { audit } from "../audit";
import {
  confirmBooking,
  failBookingWithRefund,
  InventoryUnavailableError,
  lockBooking,
} from "../bookings/lifecycle";
import { queuePaymentFailedEmail, queuePaymentReviewEmail } from "../email/notify";
import { queueEmail } from "../email/queue";
import { enqueueJob } from "../jobs/queue";
import { startMpesaPayment } from "./mpesa";
import { getProvider, providerForMethod } from "./registry";
import type { PaymentMethodKind } from "./types";

/**
 * Starts (or resumes) a payment attempt for a pending booking. The idempotency
 * key ties repeated clicks of the same "Pay" button to one payment attempt.
 * The amount always comes from the booking row, never from the browser.
 */
export async function startPayment(args: {
  booking: Booking;
  method: PaymentMethodKind;
  payerPhone?: string | null;
  idempotencyKey: string;
  returnUrl: string;
}): Promise<{ redirectUrl: string; paymentId: string }> {
  const { booking } = args;
  if (booking.status !== "pending") throw new UserError("This booking can no longer be paid.");
  if (booking.expiresAt <= new Date()) throw new UserError("Your reservation has expired. Please start again.");
  if (booking.totalMinor === 0) throw new UserError("This booking doesn't require payment.");
  if (!/^[\w-]{8,100}$/.test(args.idempotencyKey)) throw new UserError("Payment session is invalid. Please reload the page.");

  const provider = providerForMethod(args.method);
  if (!provider) throw new UserError("This payment method isn't available right now.");
  if (provider.name === "daraja") {
    return startMpesaPayment({ booking, payerPhone: args.payerPhone ?? "", idempotencyKey: args.idempotencyKey, returnUrl: args.returnUrl });
  }
  if (!provider.createPayment) throw new UserError("This payment method isn't available right now.");

  const [existing] = await db
    .select()
    .from(paymentTransactions)
    .where(eq(paymentTransactions.idempotencyKey, args.idempotencyKey));
  if (existing) {
    if (existing.bookingId !== booking.id) throw new UserError("Payment session mismatch.");
    if (existing.providerReference && existing.provider === "mock") {
      return { redirectUrl: `/pay/mock/${existing.providerReference}`, paymentId: existing.id };
    }
  }

  let payment = existing;
  if (!payment) {
    try {
      [payment] = await db
        .insert(paymentTransactions)
        .values({
          bookingId: booking.id,
          provider: provider.name,
          method: args.method,
          status: "created",
          amountMinor: booking.totalMinor,
          currency: booking.currency,
          idempotencyKey: args.idempotencyKey,
          payerPhone: args.payerPhone ?? null,
        })
        .returning();
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      [payment] = await db
        .select()
        .from(paymentTransactions)
        .where(eq(paymentTransactions.idempotencyKey, args.idempotencyKey));
    }
  }

  const result = await provider.createPayment({
    paymentId: payment.id,
    amountMinor: payment.amountMinor,
    currency: payment.currency,
    method: args.method,
    payerPhone: args.payerPhone,
    bookingReference: booking.reference,
    description: `Tickets ${booking.reference}`,
    returnUrl: args.returnUrl,
  });

  await db.transaction(async (tx) => {
    await tx
      .update(paymentTransactions)
      .set({ providerReference: result.providerReference, status: "pending", updatedAt: new Date() })
      .where(eq(paymentTransactions.id, payment.id));
    await tx
      .update(bookings)
      .set({ paymentStatus: "pending", updatedAt: new Date() })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")));
  });

  const redirectUrl = result.nextAction.type === "redirect" ? result.nextAction.url : args.returnUrl;
  return { redirectUrl, paymentId: payment.id };
}

/** A verified statement from a provider about one payment attempt. */
export type PaymentResult = {
  status: "succeeded" | "failed" | "cancelled" | "expired";
  /** Amount the provider reports, in minor units; null when not reported. */
  amountMinor: number | null;
  currency?: string;
  receipt?: string | null;
  resultCode?: string | null;
  resultDesc?: string | null;
  failureReason?: string | null;
  /** Where the evidence came from, for the audit trail. */
  source: "webhook" | "callback" | "status_query" | "admin";
  actorUserId?: string | null;
};

const FINAL_SUCCESS = new Set(["succeeded", "refunded"]);

/**
 * Applies a verified payment result exactly once. Safe against:
 *  - duplicates / replays (row lock + state checks; tickets, ledger rows and
 *    emails are also unique per booking),
 *  - out-of-order delivery (a failure never overrides a success),
 *  - late success after the hold expired (re-acquire inventory, else refund),
 *  - amount tampering and receipt reuse (flagged for reconciliation, never confirmed).
 */
export async function applyPaymentResult(paymentId: string, r: PaymentResult): Promise<string> {
  return db.transaction(async (tx) => {
    const [payment] = await tx.select().from(paymentTransactions).where(eq(paymentTransactions.id, paymentId)).for("update");
    if (!payment) return "unknown_payment";
    const now = new Date();

    const flag = async (reason: string, outcome: string, metadata: Record<string, unknown>) => {
      if (!FINAL_SUCCESS.has(payment.status)) {
        await tx
          .update(paymentTransactions)
          .set({ status: "reconciliation_required", failureReason: reason, nextStatusCheckAt: null, updatedAt: now })
          .where(eq(paymentTransactions.id, payment.id));
        await queuePaymentReviewEmail(tx, payment.id);
      }
      await audit(tx, { action: `payment.${outcome}`, entityType: "payment", entityId: payment.id, metadata: { ...metadata, source: r.source } });
      return outcome;
    };

    if (r.amountMinor !== null && (r.amountMinor !== payment.amountMinor || (r.currency && r.currency !== payment.currency))) {
      return flag(`Amount mismatch: expected ${payment.amountMinor}, provider reported ${r.amountMinor}`, "amount_mismatch_flagged", {
        expected: payment.amountMinor,
        received: r.amountMinor,
        currency: r.currency ?? payment.currency,
      });
    }
    if (r.receipt) {
      const [other] = await tx
        .select({ id: paymentTransactions.id })
        .from(paymentTransactions)
        .where(and(eq(paymentTransactions.providerReceipt, r.receipt), ne(paymentTransactions.id, payment.id)));
      if (other) return flag("Receipt already used by another payment", "receipt_reused_flagged", { receipt: r.receipt, otherPaymentId: other.id });
    }

    const booking = await lockBooking(tx, payment.bookingId);
    if (!booking) return "booking_missing";
    const providerFields = {
      providerResultCode: r.resultCode ?? payment.providerResultCode,
      providerResultDesc: r.resultDesc ?? payment.providerResultDesc,
      nextStatusCheckAt: null,
      updatedAt: now,
    };

    if (r.status !== "succeeded") {
      if (FINAL_SUCCESS.has(payment.status)) return "ignored_after_success";
      await tx
        .update(paymentTransactions)
        .set({ ...providerFields, status: r.status, failureReason: r.failureReason ?? null, completedAt: now })
        .where(eq(paymentTransactions.id, payment.id));
      if (booking.status === "pending") {
        await tx.update(bookings).set({ paymentStatus: "failed", updatedAt: now }).where(eq(bookings.id, booking.id));
        // Asynchronous outcomes only: for instant (card/mock) failures the buyer is still on the page.
        if (r.source !== "webhook") {
          await queuePaymentFailedEmail(tx, {
            paymentId: payment.id,
            bookingId: booking.id,
            eventId: booking.eventId,
            toEmail: booking.buyerEmail,
            reason: r.failureReason ?? "the payment was not completed",
          });
        }
      }
      await audit(tx, {
        actorUserId: r.actorUserId,
        action: `payment.${r.status}`,
        entityType: "payment",
        entityId: payment.id,
        metadata: { from: payment.status, source: r.source, resultCode: r.resultCode ?? null },
      });
      return `payment_${r.status}`;
    }

    // ── success ──
    if (payment.status === "succeeded") {
      if (r.receipt && !payment.providerReceipt) {
        await tx.update(paymentTransactions).set({ providerReceipt: r.receipt, updatedAt: now }).where(eq(paymentTransactions.id, payment.id));
      }
      return "already_succeeded";
    }
    if (payment.status === "refunded") return "already_refunded";
    await tx
      .update(paymentTransactions)
      .set({ ...providerFields, status: "succeeded", providerReceipt: r.receipt ?? payment.providerReceipt, failureReason: null, completedAt: now })
      .where(eq(paymentTransactions.id, payment.id));
    await audit(tx, {
      actorUserId: r.actorUserId,
      action: "payment.succeeded",
      entityType: "payment",
      entityId: payment.id,
      metadata: { from: payment.status, source: r.source, receipt: r.receipt ?? null, amountMinor: payment.amountMinor },
    });

    if (booking.status === "confirmed") {
      // A second, separate payment succeeded for an already-paid booking → refund it.
      const [refund] = await tx
        .insert(refunds)
        .values({
          bookingId: booking.id,
          paymentTransactionId: payment.id,
          amountMinor: payment.amountMinor,
          reason: "Duplicate payment for an already-paid booking",
        })
        .returning();
      await enqueueJob(tx, "refund.process", { refundId: refund.id }, { dedupeKey: `refund:${refund.id}` });
      return "duplicate_payment_refunded";
    }
    if (booking.status === "refunded" || booking.status === "failed") {
      const [refund] = await tx
        .insert(refunds)
        .values({
          bookingId: booking.id,
          paymentTransactionId: payment.id,
          amountMinor: payment.amountMinor,
          reason: `Payment received for ${booking.status} booking`,
        })
        .returning();
      await enqueueJob(tx, "refund.process", { refundId: refund.id }, { dedupeKey: `refund:${refund.id}` });
      return "payment_for_closed_booking_refunded";
    }

    // pending, expired or cancelled → try to honour the purchase.
    try {
      await tx.transaction(async (sp) => {
        await confirmBooking(sp, booking, { free: false });
      });
      return booking.status === "pending" ? "booking_confirmed" : "late_payment_confirmed";
    } catch (err) {
      if (!(err instanceof InventoryUnavailableError)) throw err;
      await failBookingWithRefund(tx, booking, payment.id, payment.amountMinor);
      return "late_payment_sold_out_refunded";
    }
  });
}

export type WebhookResult =
  | { status: 200; outcome: string }
  | { status: 400 | 401 | 404; outcome: string };

/**
 * Processes a signed provider webhook (mock provider). Daraja callbacks are
 * unsigned and take a separate path (see ./mpesa.ts).
 */
export async function handlePaymentWebhook(providerName: string, rawBody: string, headers: Headers): Promise<WebhookResult> {
  const provider = getProvider(providerName);
  if (!provider.parseWebhook) return { status: 404, outcome: "provider_has_no_signed_webhooks" };
  const parsed = await provider.parseWebhook(rawBody, headers);

  if (!parsed.valid) {
    await db.insert(paymentEvents).values({
      provider: providerName,
      providerEventId: `rejected_${randomToken(12)}`,
      signatureValid: false,
      payload: parsed.payload ?? {},
      outcome: `rejected:${parsed.reason}`,
      processedAt: new Date(),
    });
    return { status: parsed.reason === "bad_signature" ? 401 : 400, outcome: parsed.reason };
  }

  const ev = parsed.event;
  const [inserted] = await db
    .insert(paymentEvents)
    .values({
      provider: providerName,
      providerEventId: ev.eventId,
      providerReference: ev.providerReference,
      signatureValid: true,
      payload: parsed.payload as object,
    })
    .onConflictDoNothing()
    .returning({ id: paymentEvents.id });
  let eventRowId = inserted?.id;
  if (!eventRowId) {
    const [prior] = await db
      .select({ id: paymentEvents.id, processedAt: paymentEvents.processedAt })
      .from(paymentEvents)
      .where(and(eq(paymentEvents.provider, providerName), eq(paymentEvents.providerEventId, ev.eventId)));
    // Already processed → no-op. Stored but never finished (crash) → process it now.
    if (!prior || prior.processedAt) return { status: 200, outcome: "duplicate_ignored" };
    eventRowId = prior.id;
  }

  const [payment] = await db
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.provider, providerName), eq(paymentTransactions.providerReference, ev.providerReference)));
  const outcome = payment
    ? await applyPaymentResult(payment.id, {
        status: ev.status,
        amountMinor: ev.amountMinor,
        currency: ev.currency,
        failureReason: ev.failureReason ?? null,
        source: "webhook",
      })
    : "unknown_payment";

  await db.update(paymentEvents).set({ outcome, processedAt: new Date() }).where(eq(paymentEvents.id, eventRowId));
  return { status: 200, outcome };
}

/** Job handler: sends a pending refund to the provider. Idempotent. */
export async function processRefund(refundId: string) {
  const [refund] = await db.select().from(refunds).where(eq(refunds.id, refundId));
  if (!refund || refund.status === "succeeded" || refund.status === "manual_required") return;

  const payment = refund.paymentTransactionId
    ? (await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, refund.paymentTransactionId)))[0]
    : undefined;

  if (!payment || payment.status !== "succeeded" && payment.status !== "refunded") {
    // Nothing was captured (e.g. free booking) — mark as settled with no provider action.
    await db.update(refunds).set({ status: "succeeded", processedAt: new Date() }).where(eq(refunds.id, refund.id));
    await finalizeBookingRefundStatus(refund.bookingId);
    return;
  }

  const result = await getProvider(payment.provider).refund({
    providerReference: payment.providerReference!,
    amountMinor: refund.amountMinor,
    refundId: refund.id,
  });
  if (result.status === "manual") {
    // No automated refund API: an admin reverses it in the M-Pesa org portal and records it.
    await db.transaction(async (tx) => {
      await tx.update(refunds).set({ status: "manual_required" }).where(eq(refunds.id, refund.id));
      await audit(tx, {
        action: "refund.manual_required",
        entityType: "refund",
        entityId: refund.id,
        metadata: { provider: payment.provider, receipt: payment.providerReceipt, amountMinor: refund.amountMinor },
      });
    });
    return;
  }
  if (result.status === "failed") {
    await db.update(refunds).set({ status: "failed" }).where(eq(refunds.id, refund.id));
    throw new Error(`Refund failed: ${result.failureReason ?? "unknown"}`);
  }
  if (result.status === "pending") throw new Error("Refund pending at provider; will retry status check");

  await completeRefund(refund.id, payment.id, result.providerReference);
}

/** Marks a refund settled (provider-confirmed, or recorded by an admin after a manual reversal). */
export async function completeRefund(refundId: string, paymentId: string, providerReference: string, actorUserId?: string) {
  const [refund] = await db.transaction(async (tx) => {
    const rows = await tx
      .update(refunds)
      .set({ status: "succeeded", providerReference, processedAt: new Date() })
      .where(and(eq(refunds.id, refundId), ne(refunds.status, "succeeded")))
      .returning();
    if (rows.length === 0) return rows;
    await tx
      .update(paymentTransactions)
      .set({ status: "refunded", updatedAt: new Date() })
      .where(eq(paymentTransactions.id, paymentId));
    if (actorUserId) {
      await audit(tx, { actorUserId, action: "refund.recorded_manually", entityType: "refund", entityId: refundId, metadata: { providerReference } });
    }
    const [row] = await tx
      .select({ email: bookings.buyerEmail, eventId: bookings.eventId, method: paymentTransactions.method })
      .from(bookings)
      .innerJoin(paymentTransactions, eq(paymentTransactions.id, paymentId))
      .where(eq(bookings.id, rows[0].bookingId));
    if (row && rows[0].amountMinor > 0) {
      await queueEmail(tx, {
        kind: "refund_completed",
        toEmail: row.email,
        bookingId: rows[0].bookingId,
        eventId: row.eventId,
        dedupeKey: `refund_completed:${refundId}`,
        metadata: { refundId, amountMinor: rows[0].amountMinor, method: row.method },
      });
    }
    return rows;
  });
  if (refund) await finalizeBookingRefundStatus(refund.bookingId);
}

async function finalizeBookingRefundStatus(bookingId: string) {
  const open = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.bookingId, bookingId), inArray(refunds.status, ["pending", "failed", "manual_required"])));
  if (open.length === 0) {
    await db
      .update(bookings)
      .set({ paymentStatus: "refunded", updatedAt: new Date() })
      .where(and(eq(bookings.id, bookingId), eq(bookings.paymentStatus, "refund_pending")));
  }
}

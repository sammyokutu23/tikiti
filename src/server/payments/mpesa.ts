/**
 * M-Pesa Express (Daraja STK Push) orchestration.
 *
 * Payment attempt states (payment_transactions.status, provider "daraja"):
 *
 *   created ──STK accepted──▶ pending ──callback/status query──▶ succeeded | failed | cancelled | expired
 *      │                         │
 *      │ (timeout: outcome        └─ no verifiable answer after all status checks ─▶ reconciliation_required
 *      │  unknown, no ID)
 *      └─ after UNCERTAIN_WINDOW ─▶ reconciliation_required (a late callback can still be matched)
 *
 * Rules:
 *  - The customer's PIN is only ever entered in the official M-Pesa prompt.
 *  - At most one created/pending attempt per booking (partial unique index),
 *    so a double click or a second tab can never send a second prompt.
 *  - Callbacks are unsigned: they're authenticated by a secret URL token,
 *    matched to stored IDs, and (by default) confirmed with an STK status
 *    query before a booking changes. Only verified results reach
 *    applyPaymentResult(), which confirms bookings exactly once.
 *  - Missed callbacks are reconciled by bounded, backed-off status queries.
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, paymentEvents, paymentTransactions, refunds, type Booking, type PaymentTransaction } from "@/db/schema";
import { randomToken, safeEqual } from "@/lib/crypto";
import { isUniqueViolation, UserError } from "@/lib/errors";
import { formatPhone, normalizeKenyanPhone } from "@/lib/utils";
import { audit } from "../audit";
import { queuePaymentReviewEmail } from "../email/notify";
import { enqueueJob } from "../jobs/queue";
import { applyPaymentResult, type PaymentResult } from "./service";
import { darajaConfig, DarajaConfigError, type DarajaConfig } from "./providers/daraja/config";
import {
  DarajaAuthError,
  DarajaRejectedError,
  DarajaUncertainError,
  stkPush,
  stkQuery,
  type StkQueryResult,
} from "./providers/daraja/client";
import { interpretResultCode, maskMsisdn, parseStkCallback, redactCallback, type StkCallback } from "./providers/daraja/callback";

const PROVIDER = "daraja";
/** Largest single M-Pesa Express payment (KES). */
export const MPESA_MAX_KES = 250_000;
/** Give the customer time to answer the prompt even if the hold is nearly over… */
const STK_HOLD_EXTENSION_MS = 3 * 60_000;
/** …but never let repeated prompts hold inventory longer than this from checkout. */
const MAX_HOLD_FROM_CHECKOUT_MS = 25 * 60_000;
/** If Daraja never answered the initiation, wait this long for a stray callback. */
export const UNCERTAIN_WINDOW_MS = 2 * 60_000;
/** First status query if no callback has arrived (the prompt times out in ~1 min). */
const FIRST_STATUS_CHECK_MS = 90_000;
/** Backoff between status queries; after the last one the attempt needs a human. */
const STATUS_CHECK_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
export const MAX_STATUS_CHECKS = STATUS_CHECK_BACKOFF_MS.length + 1;

// ─── Initiation ──────────────────────────────────────────────────────────────

async function activeAttempt(bookingId: string) {
  const [p] = await db
    .select()
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.bookingId, bookingId), eq(paymentTransactions.provider, PROVIDER), inArray(paymentTransactions.status, ["created", "pending"])));
  return p ?? null;
}

function rejectionMessage(err: DarajaRejectedError): string {
  if (err instanceof DarajaAuthError) return "M-Pesa is temporarily unavailable. You have not been charged — please try again shortly.";
  if (err.busy) return "M-Pesa is busy right now. You have not been charged — please try again in a minute.";
  if (/lock subscriber|already in process/i.test(err.message)) {
    return "Another M-Pesa request is already open on your phone. Complete or cancel it, wait a minute, then try again.";
  }
  if (/PhoneNumber|PartyA/i.test(err.message)) return "M-Pesa didn't accept that phone number. Use a registered Safaricom M-Pesa number.";
  return "M-Pesa couldn't start the payment. You have not been charged — please try again.";
}

/**
 * Sends an STK Push for a pending booking. Returns where to send the customer
 * (the status page). Throws UserError with a customer-safe message when the
 * request was definitively not sent or refused.
 */
export async function startMpesaPayment(args: {
  booking: Booking;
  payerPhone: string;
  idempotencyKey: string;
  returnUrl: string;
  /** Defaults to the booking total; a plan installment passes its own amount. */
  amountMinor?: number;
  installmentId?: string | null;
}): Promise<{ redirectUrl: string; paymentId: string }> {
  const { booking } = args;
  const amountMinor = args.amountMinor ?? booking.totalMinor;
  const phone = normalizeKenyanPhone(args.payerPhone);
  if (!phone) throw new UserError("Enter a valid Safaricom M-Pesa number, e.g. 0712 345 678.");
  if (booking.currency !== "KES") throw new UserError("M-Pesa payments must be in KES.");
  if (amountMinor % 100 !== 0) throw new UserError("M-Pesa only accepts whole shillings. Please contact the organizer.");
  if (amountMinor > MPESA_MAX_KES * 100) {
    throw new UserError(`M-Pesa payments are limited to KES ${MPESA_MAX_KES.toLocaleString("en-KE")} per transaction. Please reduce your order.`);
  }

  let cfg: DarajaConfig;
  try {
    cfg = darajaConfig();
  } catch (err) {
    if (err instanceof DarajaConfigError) console.error("[mpesa] configuration error:", err.message);
    throw new UserError("M-Pesa payments are temporarily unavailable. You have not been charged.");
  }

  // The same click delivered twice → the same attempt.
  const [same] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.idempotencyKey, args.idempotencyKey));
  if (same) {
    if (same.bookingId !== booking.id) throw new UserError("Payment session mismatch.");
    return { redirectUrl: args.returnUrl, paymentId: same.id };
  }

  // Another prompt already in flight for this booking → resolve it before sending a new one.
  let active = await activeAttempt(booking.id);
  if (active?.status === "pending" && active.providerReference && Date.now() - active.createdAt.getTime() > 30_000) {
    await checkMpesaPaymentStatus(active.id, { cfg });
    active = await activeAttempt(booking.id);
  }
  if (active) return { redirectUrl: args.returnUrl, paymentId: active.id };

  let payment: PaymentTransaction;
  try {
    [payment] = await db
      .insert(paymentTransactions)
      .values({
        bookingId: booking.id,
        provider: PROVIDER,
        method: "mpesa",
        status: "created",
        amountMinor,
        currency: booking.currency,
        idempotencyKey: args.idempotencyKey,
        payerPhone: phone,
        installmentId: args.installmentId ?? null,
        nextStatusCheckAt: new Date(Date.now() + UNCERTAIN_WINDOW_MS),
      })
      .returning();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost a race with another click/tab: show the attempt that won.
    const winner = (await activeAttempt(booking.id)) ?? (await db.select().from(paymentTransactions).where(eq(paymentTransactions.idempotencyKey, args.idempotencyKey)))[0];
    if (!winner) throw new UserError("Please try again.");
    return { redirectUrl: args.returnUrl, paymentId: winner.id };
  }

  try {
    const accepted = await stkPush(cfg, {
      amountKes: amountMinor / 100,
      phone,
      accountReference: booking.reference,
      description: args.installmentId ? "Ticket installment" : "Event tickets",
    });
    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(paymentTransactions)
        .set({
          status: "pending",
          providerReference: accepted.checkoutRequestId,
          merchantRequestId: accepted.merchantRequestId,
          failureReason: null,
          nextStatusCheckAt: new Date(now.getTime() + FIRST_STATUS_CHECK_MS),
          updatedAt: now,
        })
        .where(eq(paymentTransactions.id, payment.id));
      // Don't let the hold lapse while the customer is entering their PIN (bounded).
      const extended = new Date(Math.min(now.getTime() + STK_HOLD_EXTENSION_MS, booking.createdAt.getTime() + MAX_HOLD_FROM_CHECKOUT_MS));
      await tx
        .update(bookings)
        .set({ paymentStatus: "pending", expiresAt: sql`GREATEST(${bookings.expiresAt}, ${extended.toISOString()}::timestamptz)`, updatedAt: now })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")));
      await audit(tx, {
        action: "payment.stk_sent",
        entityType: "payment",
        entityId: payment.id,
        metadata: { env: cfg.env, phone: maskMsisdn(phone), amountMinor: payment.amountMinor, checkoutRequestId: accepted.checkoutRequestId },
      });
    });
    return { redirectUrl: args.returnUrl, paymentId: payment.id };
  } catch (err) {
    if (err instanceof DarajaRejectedError) {
      const message = rejectionMessage(err);
      await db.transaction(async (tx) => {
        await tx
          .update(paymentTransactions)
          .set({ status: "failed", failureReason: message, providerResultCode: err.code, providerResultDesc: err.message.slice(0, 300), nextStatusCheckAt: null, completedAt: new Date(), updatedAt: new Date() })
          .where(eq(paymentTransactions.id, payment.id));
        await audit(tx, { action: "payment.stk_rejected", entityType: "payment", entityId: payment.id, metadata: { code: err.code, httpStatus: err.httpStatus } });
      });
      console.warn(`[mpesa] STK request refused (payment ${payment.id}): ${err.code}`);
      throw new UserError(message);
    }
    // Timeout or unreadable reply: a prompt may be on the customer's phone. Never
    // fire another one blindly — keep this attempt "created" (it blocks new
    // prompts) and let the reconciler / a stray callback settle it.
    await db.transaction(async (tx) => {
      await tx
        .update(paymentTransactions)
        .set({ failureReason: "M-Pesa did not confirm the request in time; outcome unknown", updatedAt: new Date() })
        .where(eq(paymentTransactions.id, payment.id));
      await tx
        .update(bookings)
        .set({ paymentStatus: "pending", updatedAt: new Date() })
        .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")));
      await audit(tx, { action: "payment.stk_uncertain", entityType: "payment", entityId: payment.id, metadata: { error: err instanceof DarajaUncertainError ? err.message : "unexpected" } });
    });
    if (!(err instanceof DarajaUncertainError)) console.error(`[mpesa] unexpected STK error (payment ${payment.id}):`, (err as Error).name);
    return { redirectUrl: args.returnUrl, paymentId: payment.id };
  }
}

// ─── Callback ────────────────────────────────────────────────────────────────

export type CallbackResponse = { status: number; body: Record<string, unknown>; eventId?: string };
const ACK = { ResultCode: 0, ResultDesc: "Accepted" };

/**
 * Receives an STK callback: authenticates the URL token, validates the shape,
 * stores a redacted copy and queues verification. Responds immediately; the
 * booking is changed by the queued job (processMpesaCallbackEvent).
 */
export async function receiveMpesaCallback(rawBody: string, ctx: { token: string; ip: string | null }): Promise<CallbackResponse> {
  let cfg: DarajaConfig;
  try {
    cfg = darajaConfig();
  } catch {
    return { status: 503, body: { ResultCode: 1, ResultDesc: "Not configured" } };
  }
  const reject = async (reason: string, status: number, payload: Record<string, unknown> = {}) => {
    await db.insert(paymentEvents).values({
      provider: PROVIDER,
      kind: "callback",
      providerEventId: `rejected_${randomToken(12)}`,
      signatureValid: false,
      payload,
      outcome: `rejected:${reason}`,
      processedAt: new Date(),
    });
    return { status, body: { ResultCode: 1, ResultDesc: "Rejected" } };
  };

  if (!safeEqual(ctx.token, cfg.callbackToken)) return reject("bad_token", 404);
  if (cfg.callbackAllowedIps.length && (!ctx.ip || !cfg.callbackAllowedIps.includes(ctx.ip))) return reject("ip_not_allowed", 403, { ip: ctx.ip });

  const parsed = parseStkCallback(rawBody);
  if (!parsed.ok) return reject(parsed.reason, 400);
  const cb = parsed.callback;

  const eventId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(paymentEvents)
      .values({
        provider: PROVIDER,
        kind: "callback",
        // One result per checkout request: a resend of the same result is a duplicate.
        providerEventId: `cb:${cb.checkoutRequestId}:${cb.resultCode}`,
        providerReference: cb.checkoutRequestId,
        signatureValid: true, // URL token matched (Safaricom does not sign callbacks)
        payload: { ...redactCallback(cb), _phone: cb.phone },
      })
      .onConflictDoNothing()
      .returning({ id: paymentEvents.id });
    if (!row) return null;
    await enqueueJob(tx, "payment.mpesa_callback", { eventId: row.id }, { dedupeKey: `mpesa_callback:${row.id}`, maxAttempts: 5 });
    return row.id;
  });
  return eventId ? { status: 200, body: ACK, eventId } : { status: 200, body: { ...ACK, duplicate: true } };
}

function resultFromCallback(cb: StkCallback): PaymentResult {
  const meaning = interpretResultCode(cb.resultCode);
  return {
    status: meaning.status,
    amountMinor: cb.resultCode === "0" ? Math.round((cb.amountKes ?? 0) * 100) : null,
    currency: "KES",
    receipt: cb.receipt,
    resultCode: cb.resultCode,
    resultDesc: cb.resultDesc,
    failureReason: meaning.status === "succeeded" ? null : meaning.customerMessage,
    source: "callback",
  };
}

function resultFromQuery(q: Extract<StkQueryResult, { state: "final" }>): PaymentResult {
  const meaning = interpretResultCode(q.resultCode);
  return {
    status: meaning.status,
    // The query reports no amount; the authoritative answer is about the
    // CheckoutRequestID we created for exactly payment.amountMinor.
    amountMinor: null,
    receipt: null,
    resultCode: q.resultCode,
    resultDesc: q.resultDesc,
    failureReason: meaning.status === "succeeded" ? null : meaning.customerMessage,
    source: "status_query",
  };
}

async function recordQuery(payment: PaymentTransaction, q: StkQueryResult, outcome: string) {
  await db.insert(paymentEvents).values({
    provider: PROVIDER,
    kind: "status_query",
    providerEventId: `query:${payment.providerReference}:${randomToken(6)}`,
    providerReference: payment.providerReference,
    signatureValid: true, // our own authenticated request to Safaricom
    payload: q.state === "final" ? { state: q.state, ResultCode: q.resultCode, ResultDesc: q.resultDesc } : { state: q.state, detail: q.detail },
    outcome,
    processedAt: new Date(),
  });
}

/**
 * Job handler for a stored callback. Throws to retry (with backoff) while the
 * outcome can't be verified; on the final attempt the payment is flagged for
 * reconciliation instead of guessing.
 */
export async function processMpesaCallbackEvent(eventRowId: string, attempt: { isLast: boolean }): Promise<string> {
  const [ev] = await db.select().from(paymentEvents).where(eq(paymentEvents.id, eventRowId));
  if (!ev || ev.processedAt) return "already_processed";
  const stored = ev.payload as ReturnType<typeof redactCallback> & { _phone: string | null };
  const cb: StkCallback = {
    merchantRequestId: stored.MerchantRequestID,
    checkoutRequestId: stored.CheckoutRequestID,
    resultCode: String(stored.ResultCode),
    resultDesc: stored.ResultDesc,
    amountKes: stored.Amount,
    receipt: stored.MpesaReceiptNumber,
    transactionDate: stored.TransactionDate,
    phone: stored._phone,
  };
  const cfg = darajaConfig();

  const finish = async (outcome: string) => {
    // Drop the unmasked phone once it has served its matching purpose.
    const { _phone: _unused, ...rest } = stored;
    void _unused;
    await db.update(paymentEvents).set({ outcome, processedAt: new Date(), payload: rest }).where(eq(paymentEvents.id, ev.id));
    return outcome;
  };

  let [payment] = await db
    .select()
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.provider, PROVIDER), eq(paymentTransactions.providerReference, cb.checkoutRequestId)));

  if (!payment) {
    const matched = cb.resultCode === "0" ? await matchOrphanCallback(cb) : null;
    if (!matched) {
      if (cb.resultCode === "0") {
        await audit(null, {
          action: "payment.unmatched_mpesa_success",
          entityType: "payment_event",
          entityId: ev.id,
          metadata: { checkoutRequestId: cb.checkoutRequestId, receipt: cb.receipt, amountKes: cb.amountKes },
        });
        return finish("unknown_checkout_request_paid");
      }
      return finish("unknown_checkout_request");
    }
    payment = matched;
  }

  if (payment.merchantRequestId && payment.merchantRequestId !== cb.merchantRequestId) {
    await audit(null, { action: "payment.callback_id_mismatch", entityType: "payment", entityId: payment.id, metadata: { eventId: ev.id } });
    return finish("merchant_request_id_mismatch");
  }

  let result = resultFromCallback(cb);
  let outcomeSuffix = "";
  if (cfg.verifyCallbacks) {
    const q = await stkQuery(cfg, cb.checkoutRequestId);
    if (q.state !== "final") {
      await recordQuery(payment, q, `callback_verification_${q.state}`);
      if (!attempt.isLast) throw new Error(`M-Pesa status not yet verifiable (${q.state})`);
      await db
        .update(paymentTransactions)
        .set({
          status: "reconciliation_required",
          failureReason: `Callback reported result ${cb.resultCode} but the status query could not confirm it`,
          nextStatusCheckAt: null,
          updatedAt: new Date(),
        })
        .where(and(eq(paymentTransactions.id, payment.id), inArray(paymentTransactions.status, ["created", "pending", "reconciliation_required"])));
      await db.transaction((tx) => queuePaymentReviewEmail(tx, payment.id));
      return finish("unverified_flagged");
    }
    const agrees = (q.resultCode === "0") === (cb.resultCode === "0");
    await recordQuery(payment, q, agrees ? "confirms_callback" : "contradicts_callback");
    if (!agrees) {
      // The authenticated query wins over an unsigned callback.
      result = resultFromQuery(q);
      outcomeSuffix = ":contradicted_by_query";
      await audit(null, {
        action: "payment.callback_contradicted",
        entityType: "payment",
        entityId: payment.id,
        metadata: { callbackResult: cb.resultCode, queryResult: q.resultCode },
      });
    }
  }
  const outcome = await applyPaymentResult(payment.id, result);
  return finish(outcome + outcomeSuffix);
}

/**
 * A successful callback whose CheckoutRequestID we never received (the STK
 * request timed out). Match it to the single uncertain attempt with the same
 * phone and amount from the last 30 minutes; otherwise leave it for an admin.
 */
async function matchOrphanCallback(cb: StkCallback): Promise<PaymentTransaction | null> {
  if (!cb.phone || cb.amountKes === null) return null;
  const candidates = await db
    .select()
    .from(paymentTransactions)
    .where(
      and(
        eq(paymentTransactions.provider, PROVIDER),
        isNull(paymentTransactions.providerReference),
        inArray(paymentTransactions.status, ["created", "reconciliation_required"]),
        eq(paymentTransactions.payerPhone, cb.phone),
        eq(paymentTransactions.amountMinor, Math.round(cb.amountKes * 100)),
        gt(paymentTransactions.createdAt, new Date(Date.now() - 30 * 60_000)),
      ),
    );
  if (candidates.length !== 1) return null;
  const [linked] = await db
    .update(paymentTransactions)
    .set({ providerReference: cb.checkoutRequestId, merchantRequestId: cb.merchantRequestId, updatedAt: new Date() })
    .where(and(eq(paymentTransactions.id, candidates[0].id), isNull(paymentTransactions.providerReference)))
    .returning();
  if (linked) {
    await audit(null, { action: "payment.orphan_callback_matched", entityType: "payment", entityId: linked.id, metadata: { checkoutRequestId: cb.checkoutRequestId } });
  }
  return linked ?? null;
}

// ─── Status queries / reconciliation ─────────────────────────────────────────

/**
 * Asks Daraja for the result of one attempt and applies it if final. Used by
 * the reconciler (missed callbacks), before allowing a new prompt, and by
 * admins ("Check status now").
 */
export async function checkMpesaPaymentStatus(paymentId: string, opts: { cfg?: DarajaConfig; manual?: boolean } = {}): Promise<string> {
  const [payment] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, paymentId));
  if (!payment || payment.provider !== PROVIDER) return "not_mpesa";
  if (!["created", "pending", "reconciliation_required"].includes(payment.status)) return `already_${payment.status}`;
  const now = new Date();

  if (!payment.providerReference) {
    // No CheckoutRequestID → nothing to query. Once the window for a stray
    // callback has passed, unblock retries but keep it visible to admins.
    if (payment.status === "created" && now.getTime() - payment.createdAt.getTime() >= UNCERTAIN_WINDOW_MS) {
      await db.transaction(async (tx) => {
        await tx
          .update(paymentTransactions)
          .set({ status: "reconciliation_required", failureReason: "M-Pesa never confirmed the request; no prompt reference to check", nextStatusCheckAt: null, updatedAt: now })
          .where(and(eq(paymentTransactions.id, payment.id), eq(paymentTransactions.status, "created")));
        await audit(tx, { action: "payment.reconciliation_required", entityType: "payment", entityId: payment.id, metadata: { reason: "initiation_outcome_unknown" } });
        await queuePaymentReviewEmail(tx, payment.id);
      });
      return "uncertain_initiation_flagged";
    }
    return "awaiting_uncertain_window";
  }

  const cfg = opts.cfg ?? darajaConfig();
  const q = await stkQuery(cfg, payment.providerReference);
  const attempts = payment.statusCheckAttempts + 1;

  if (q.state === "final") {
    const outcome = await applyPaymentResult(payment.id, resultFromQuery(q));
    await db.update(paymentTransactions).set({ statusCheckAttempts: attempts, lastStatusCheckAt: now }).where(eq(paymentTransactions.id, payment.id));
    await recordQuery(payment, q, outcome);
    return outcome;
  }

  const exhausted = !opts.manual && attempts >= MAX_STATUS_CHECKS;
  await db.transaction(async (tx) => {
    await tx
      .update(paymentTransactions)
      .set({
        statusCheckAttempts: attempts,
        lastStatusCheckAt: now,
        nextStatusCheckAt: exhausted ? null : new Date(now.getTime() + STATUS_CHECK_BACKOFF_MS[Math.min(attempts - 1, STATUS_CHECK_BACKOFF_MS.length - 1)]),
        ...(exhausted ? { status: "reconciliation_required" as const, failureReason: `M-Pesa status could not be confirmed after ${attempts} checks (${q.state})` } : {}),
        updatedAt: now,
      })
      .where(and(eq(paymentTransactions.id, payment.id), inArray(paymentTransactions.status, ["created", "pending", "reconciliation_required"])));
    if (exhausted) {
      await audit(tx, { action: "payment.reconciliation_required", entityType: "payment", entityId: payment.id, metadata: { reason: "status_unverifiable", attempts } });
      await queuePaymentReviewEmail(tx, payment.id);
    }
  });
  const outcome = exhausted ? "status_unverifiable_flagged" : `status_${q.state}`;
  await recordQuery(payment, q, outcome);
  return outcome;
}

/**
 * Worker step: checks attempts whose callback is overdue. Claims rows by
 * pushing next_status_check_at forward first, so parallel workers don't query
 * the same attempt; Daraja traffic is bounded by `limit` and the backoff.
 */
export async function reconcileMpesaPayments(now = new Date(), limit = 10): Promise<number> {
  const due = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: paymentTransactions.id })
      .from(paymentTransactions)
      .where(and(eq(paymentTransactions.provider, PROVIDER), inArray(paymentTransactions.status, ["created", "pending"]), lte(paymentTransactions.nextStatusCheckAt, now)))
      .orderBy(asc(paymentTransactions.nextStatusCheckAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    if (rows.length) {
      await tx
        .update(paymentTransactions)
        .set({ nextStatusCheckAt: new Date(now.getTime() + 5 * 60_000) })
        .where(inArray(paymentTransactions.id, rows.map((r) => r.id)));
    }
    return rows;
  });
  if (due.length === 0) return 0;
  let cfg: DarajaConfig;
  try {
    cfg = darajaConfig();
  } catch (err) {
    console.error("[mpesa] reconciliation skipped:", (err as Error).message);
    return 0;
  }
  for (const { id } of due) {
    try {
      await checkMpesaPaymentStatus(id, { cfg });
    } catch (err) {
      console.error(`[mpesa] status check failed for payment ${id}:`, (err as Error).message);
    }
  }
  return due.length;
}

// ─── Admin visibility & resolution ───────────────────────────────────────────

/** M-Pesa items an operator must look at. */
export async function mpesaAttentionItems() {
  const staleBefore = new Date(Date.now() - 10 * 60_000);
  const [payments, manualRefunds, orphanCallbacks] = await Promise.all([
    db
      .select({ p: paymentTransactions, reference: bookings.reference, bookingStatus: bookings.status })
      .from(paymentTransactions)
      .innerJoin(bookings, eq(bookings.id, paymentTransactions.bookingId))
      .where(
        and(
          eq(paymentTransactions.provider, PROVIDER),
          or(
            eq(paymentTransactions.status, "reconciliation_required"),
            and(inArray(paymentTransactions.status, ["created", "pending"]), lte(paymentTransactions.createdAt, staleBefore)),
          ),
        ),
      )
      .orderBy(desc(paymentTransactions.createdAt))
      .limit(50),
    db
      .select({ r: refunds, reference: bookings.reference, receipt: paymentTransactions.providerReceipt, phone: paymentTransactions.payerPhone })
      .from(refunds)
      .innerJoin(bookings, eq(bookings.id, refunds.bookingId))
      .leftJoin(paymentTransactions, eq(paymentTransactions.id, refunds.paymentTransactionId))
      .where(eq(refunds.status, "manual_required"))
      .orderBy(desc(refunds.createdAt))
      .limit(50),
    db
      .select()
      .from(paymentEvents)
      .where(and(eq(paymentEvents.provider, PROVIDER), eq(paymentEvents.outcome, "unknown_checkout_request_paid")))
      .orderBy(desc(paymentEvents.createdAt))
      .limit(50),
  ]);
  return { payments, manualRefunds, orphanCallbacks };
}

const RECEIPT_RE = /^[A-Z0-9]{8,20}$/;

/**
 * Admin decision after checking the M-Pesa org portal statement.
 * "paid" requires the receipt and goes through the same once-only confirmation path.
 */
export async function resolveMpesaPayment(args: { paymentId: string; resolution: "paid" | "not_paid"; receipt?: string; actorUserId: string }) {
  const [payment] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, args.paymentId));
  if (!payment || payment.provider !== PROVIDER) throw new UserError("Payment not found.");
  if (!["created", "pending", "reconciliation_required"].includes(payment.status)) throw new UserError(`This payment is already ${payment.status}.`);
  if (args.resolution === "paid") {
    const receipt = (args.receipt ?? "").trim().toUpperCase();
    if (!RECEIPT_RE.test(receipt)) throw new UserError("Enter the M-Pesa receipt number from the org portal statement.");
    return applyPaymentResult(payment.id, { status: "succeeded", amountMinor: null, receipt, source: "admin", actorUserId: args.actorUserId, resultDesc: "Confirmed by admin from M-Pesa statement" });
  }
  return applyPaymentResult(payment.id, {
    status: "failed",
    amountMinor: null,
    failureReason: "No payment was received (resolved by an administrator)",
    source: "admin",
    actorUserId: args.actorUserId,
  });
}

export function describePayer(phone: string | null) {
  return phone ? formatPhone(phone) : "—";
}

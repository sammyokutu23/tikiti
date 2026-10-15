/**
 * Lipa Mdogo Mdogo — customer, organizer and admin operations on payment plans.
 * Schedule maths: ./policy.ts. Payment application and expiry: ./apply.ts.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bookings,
  events,
  organizerProfiles,
  paymentPlans,
  paymentTransactions,
  planInstallments,
  refunds,
  type Booking,
  type Event,
  type PaymentPlan,
  type User,
} from "@/db/schema";
import { UserError } from "@/lib/errors";
import { audit } from "../audit";
import { bookingLines, lockBooking } from "../bookings/lifecycle";
import { holdInventory, InventoryUnavailableError } from "../inventory";
import { checkoutPaymentModes } from "../payments/options";
import { applyPaymentResult, startPayment } from "../payments/service";
import { endPlan, planPolicyOf, refundPayment, unappliedPlanPayments } from "./apply";
import { getPlanPolicy, PLAN_TERMS_VERSION, planOptions, planTerms, quotePlan, type PlanQuote } from "./policy";

const DAY = 86_400_000;

// ─── Checkout offer & creation ───────────────────────────────────────────────

export type PlanOffer =
  | { available: true; options: PlanQuote[]; terms: string[] }
  | { available: false; reason: string };

/** What the payment page may offer for this booking (computed on the server). */
export async function planOfferForBooking(booking: Booking, event: Event, now = new Date()): Promise<PlanOffer> {
  if (!event.installmentsEnabled) return { available: false, reason: "The organizer hasn't enabled payment plans for this event." };
  if (booking.status !== "pending" || booking.totalMinor === 0) return { available: false, reason: "This order can't use a payment plan." };
  if (checkoutPaymentModes().mpesa === "unavailable") return { available: false, reason: "Payment plans need M-Pesa, which is unavailable right now." };
  const policy = await getPlanPolicy();
  const { options, reason } = planOptions({ totalMinor: booking.totalMinor, eventStartsAt: event.startsAt, policy, now });
  if (!options.length) return { available: false, reason: reason! };
  return { available: true, options, terms: planTerms(options[0], policy, event.refundPolicy) };
}

/**
 * Creates (or, before any deposit attempt, re-plans) the plan for a pending
 * booking. Amounts and due dates are fixed here and never recomputed later.
 */
export async function createPlan(args: { booking: Booking; installmentCount: number; acceptedTerms: boolean; now?: Date }): Promise<PaymentPlan> {
  if (!args.acceptedTerms) throw new UserError("Please read and accept the payment plan terms.");
  const now = args.now ?? new Date();
  return db.transaction(async (tx) => {
    const booking = await lockBooking(tx, args.booking.id);
    if (!booking || booking.status !== "pending" || booking.expiresAt <= now) throw new UserError("Your reservation has expired. Please start again.");
    const [event] = await tx.select().from(events).where(eq(events.id, booking.eventId));
    if (!event?.installmentsEnabled) throw new UserError("Payment plans aren't available for this event.");
    const policy = await getPlanPolicy(tx);
    const q = quotePlan({ totalMinor: booking.totalMinor, eventStartsAt: event.startsAt, policy, installmentCount: args.installmentCount, now });
    if ("eligible" in q) throw new UserError(q.reason);

    const [existing] = await tx.select().from(paymentPlans).where(eq(paymentPlans.bookingId, booking.id)).for("update");
    if (existing) {
      if (existing.status !== "awaiting_deposit") throw new UserError("This booking already has a payment plan.");
      const attempts = await tx.$count(paymentTransactions, sql`${paymentTransactions.installmentId} in (select id from ${planInstallments} where plan_id = ${existing.id})`);
      if (attempts > 0) {
        if (existing.installmentCount === q.installmentCount) return existing;
        throw new UserError("A deposit request was already sent for this plan. Finish or cancel it before changing the plan.");
      }
      await tx.delete(planInstallments).where(eq(planInstallments.planId, existing.id));
      await tx.delete(paymentPlans).where(eq(paymentPlans.id, existing.id));
    }
    const [plan] = await tx
      .insert(paymentPlans)
      .values({
        bookingId: booking.id,
        currency: booking.currency,
        totalMinor: q.totalMinor,
        depositMinor: q.depositMinor,
        installmentCount: q.installmentCount,
        finalDueAt: q.finalDueAt,
        cancellationFeeMinor: q.cancellationFeeMinor,
        policy,
        termsVersion: PLAN_TERMS_VERSION,
        termsAcceptedAt: now,
      })
      .returning();
    await tx.insert(planInstallments).values(
      q.lines.map((l) => ({
        planId: plan.id,
        sequence: l.sequence,
        amountMinor: l.amountMinor,
        dueAt: l.dueAt,
        status: l.sequence === 0 || l.dueAt.getTime() - policy.reminderDaysBefore * DAY <= now.getTime() ? ("due" as const) : ("scheduled" as const),
      })),
    );
    await audit(tx, {
      actorUserId: booking.userId,
      action: "plan.created",
      entityType: "payment_plan",
      entityId: plan.id,
      metadata: { bookingId: booking.id, totalMinor: q.totalMinor, depositMinor: q.depositMinor, installments: q.lines.slice(1).map((l) => l.amountMinor), termsVersion: PLAN_TERMS_VERSION },
    });
    return plan;
  });
}

// ─── Paying installments ─────────────────────────────────────────────────────

export async function loadPlan(bookingId: string) {
  const [plan] = await db.select().from(paymentPlans).where(eq(paymentPlans.bookingId, bookingId));
  if (!plan) return null;
  const installments = await db.select().from(planInstallments).where(eq(planInstallments.planId, plan.id)).orderBy(asc(planInstallments.sequence));
  return { plan, installments };
}

/**
 * Sends the M-Pesa request for the next unpaid installment (always the full
 * installment amount, never more than what's outstanding). Refuses while any
 * earlier request for this booking might still succeed, so a customer can't be
 * charged twice for the same installment.
 */
export async function startPlanPayment(args: { booking: Booking; payerPhone: string; idempotencyKey: string; returnUrl: string }) {
  const loaded = await loadPlan(args.booking.id);
  if (!loaded) throw new UserError("This booking has no payment plan.");
  const { plan, installments } = loaded;
  if (plan.status === "fully_paid") throw new UserError("This plan is fully paid — your tickets have been issued.");
  if (plan.status === "reconciliation_required") throw new UserError("We're reviewing a recent payment on this plan. Please don't pay again — we'll email you.");
  if (plan.status !== "awaiting_deposit" && plan.status !== "active") throw new UserError("This payment plan has ended and can't be paid.");
  const next = installments.find((i) => i.status !== "paid" && i.status !== "cancelled");
  if (!next) throw new UserError("Nothing is left to pay on this plan.");
  if (plan.totalMinor - plan.paidMinor < next.amountMinor) throw new UserError("This payment would exceed your outstanding balance. Please contact support.");

  const [inFlight] = await db
    .select()
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.bookingId, args.booking.id), inArray(paymentTransactions.status, ["created", "pending", "reconciliation_required"])))
    .orderBy(desc(paymentTransactions.createdAt))
    .limit(1);
  if (inFlight?.status === "reconciliation_required") {
    throw new UserError("We're still confirming your previous M-Pesa payment. Please don't pay again — we'll update you shortly.");
  }
  if (inFlight && inFlight.installmentId === next.id) return { paymentId: inFlight.id, redirectUrl: args.returnUrl, installmentId: next.id };

  const res = await startPayment({
    booking: args.booking,
    method: "mpesa",
    payerPhone: args.payerPhone,
    idempotencyKey: args.idempotencyKey,
    returnUrl: args.returnUrl,
    installment: { id: next.id, amountMinor: next.amountMinor },
  });
  const [p] = await db.select({ status: paymentTransactions.status, installmentId: paymentTransactions.installmentId }).from(paymentTransactions).where(eq(paymentTransactions.id, res.paymentId));
  if (p && p.installmentId === next.id && (p.status === "created" || p.status === "pending")) {
    await db
      .update(planInstallments)
      .set({ status: "payment_pending", updatedAt: new Date() })
      .where(and(eq(planInstallments.id, next.id), inArray(planInstallments.status, ["scheduled", "due", "failed", "overdue"])));
  }
  return { ...res, installmentId: next.id };
}

/** The customer ends their own plan: tickets released, payments refunded per the accepted terms. */
export async function cancelPlanByCustomer(bookingId: string, actorUserId: string | null) {
  return db.transaction(async (tx) => {
    const booking = await lockBooking(tx, bookingId);
    if (!booking) throw new UserError("Booking not found.");
    const [inFlight] = await tx
      .select({ id: paymentTransactions.id })
      .from(paymentTransactions)
      .where(and(eq(paymentTransactions.bookingId, bookingId), inArray(paymentTransactions.status, ["created", "pending", "reconciliation_required"])));
    if (inFlight) throw new UserError("A payment is still being confirmed. Please wait for it to finish before cancelling.");
    const r = await endPlan(tx, bookingId, "customer_cancelled", actorUserId ?? undefined);
    if (!r) throw new UserError("This plan can't be cancelled (it's already finished or fully paid).");
    return r;
  });
}

// ─── Views ───────────────────────────────────────────────────────────────────

/** Customer-safe view of a plan: no provider ids, receipts or phone numbers. */
export async function planView(bookingId: string) {
  const loaded = await loadPlan(bookingId);
  if (!loaded) return null;
  const { plan, installments } = loaded;
  const payments = await db
    .select({ id: paymentTransactions.id, status: paymentTransactions.status, amountMinor: paymentTransactions.amountMinor, createdAt: paymentTransactions.createdAt, completedAt: paymentTransactions.completedAt, failureReason: paymentTransactions.failureReason, installmentId: paymentTransactions.installmentId })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.bookingId, bookingId), sql`${paymentTransactions.installmentId} is not null`))
    .orderBy(desc(paymentTransactions.createdAt));
  const planRefunds = await db.select({ amountMinor: refunds.amountMinor, status: refunds.status, createdAt: refunds.createdAt }).from(refunds).where(eq(refunds.bookingId, bookingId));
  const next = installments.find((i) => i.status !== "paid" && i.status !== "cancelled") ?? null;
  const inFlight = payments.find((p) => p.status === "created" || p.status === "pending" || p.status === "reconciliation_required") ?? null;
  return {
    plan,
    installments,
    payments,
    refunds: planRefunds,
    outstandingMinor: plan.totalMinor - plan.paidMinor,
    next,
    inFlight,
    policy: planPolicyOf(plan),
    canPay: (plan.status === "awaiting_deposit" || plan.status === "active") && !!next && !inFlight,
    canCancel: (plan.status === "awaiting_deposit" || plan.status === "active") && !inFlight,
  };
}
export type PlanView = NonNullable<Awaited<ReturnType<typeof planView>>>;

const ACTIVE_STATES = ["awaiting_deposit", "active", "reconciliation_required"] as const;

/** Organizer dashboard: only plans for this organizer's own events. Buyer contact details are not included. */
export async function organizerPlans(organizerId: string) {
  const rows = await db
    .select({
      plan: paymentPlans,
      reference: bookings.reference,
      buyerName: bookings.buyerName,
      eventId: events.id,
      eventTitle: events.title,
      timezone: events.timezone,
      nextDueAt: sql<Date | null>`(select min(i.due_at) from ${planInstallments} i where i.plan_id = ${paymentPlans.id} and i.status not in ('paid','cancelled'))`.mapWith((v) => (v ? new Date(v) : null)),
    })
    .from(paymentPlans)
    .innerJoin(bookings, eq(bookings.id, paymentPlans.bookingId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(eq(events.organizerId, organizerId))
    .orderBy(desc(paymentPlans.createdAt))
    .limit(300);
  const active = rows.filter((r) => r.plan.status === "active" || r.plan.status === "reconciliation_required");
  return {
    rows,
    stats: {
      active: active.length,
      collectedMinor: active.reduce((s, r) => s + r.plan.paidMinor, 0),
      outstandingMinor: active.reduce((s, r) => s + r.plan.totalMinor - r.plan.paidMinor, 0),
      fullyPaid: rows.filter((r) => r.plan.status === "fully_paid").length,
      ended: rows.filter((r) => ["cancelled", "expired", "refund_pending", "refunded"].includes(r.plan.status) && r.plan.activatedAt).length,
    },
    upcoming: active
      .filter((r) => r.nextDueAt)
      .sort((a, b) => a.nextDueAt!.getTime() - b.nextDueAt!.getTime())
      .slice(0, 10),
  };
}

export async function adminPlans(filter: "attention" | "active" | "all") {
  const now = new Date();
  const where =
    filter === "attention"
      ? sql`${paymentPlans.status} in ('reconciliation_required','refund_pending') or (${paymentPlans.status} = 'active' and exists (select 1 from ${planInstallments} i where i.plan_id = ${paymentPlans.id} and i.status in ('overdue','payment_pending','failed')))`
      : filter === "active"
        ? inArray(paymentPlans.status, [...ACTIVE_STATES])
        : undefined;
  const rows = await db
    .select({ plan: paymentPlans, reference: bookings.reference, buyerName: bookings.buyerName, buyerEmail: bookings.buyerEmail, eventTitle: events.title, organizer: organizerProfiles.displayName })
    .from(paymentPlans)
    .innerJoin(bookings, eq(bookings.id, paymentPlans.bookingId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(where)
    .orderBy(desc(paymentPlans.updatedAt))
    .limit(200);
  return { rows, now };
}

export async function adminPlanDetail(planId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(planId)) return null;
  const [row] = await db
    .select({ plan: paymentPlans, booking: bookings, event: events })
    .from(paymentPlans)
    .innerJoin(bookings, eq(bookings.id, paymentPlans.bookingId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(eq(paymentPlans.id, planId));
  if (!row) return null;
  const [installments, payments, planRefunds, unapplied] = await Promise.all([
    db.select().from(planInstallments).where(eq(planInstallments.planId, planId)).orderBy(asc(planInstallments.sequence)),
    db.select().from(paymentTransactions).where(eq(paymentTransactions.bookingId, row.booking.id)).orderBy(desc(paymentTransactions.createdAt)),
    db.select().from(refunds).where(eq(refunds.bookingId, row.booking.id)).orderBy(desc(refunds.createdAt)),
    unappliedPlanPayments(db, planId),
  ]);
  return { ...row, installments, payments, refunds: planRefunds, unapplied: unapplied.map((u) => u.p) };
}

// ─── Admin resolution ────────────────────────────────────────────────────────

export async function adminCancelPlan(planId: string, actor: User, reason: string) {
  return db.transaction(async (tx) => {
    const [plan] = await tx.select().from(paymentPlans).where(eq(paymentPlans.id, planId));
    if (!plan) throw new UserError("Plan not found.");
    await lockBooking(tx, plan.bookingId);
    const r = await endPlan(tx, plan.bookingId, "admin_cancelled", actor.id);
    if (!r) throw new UserError(`A ${plan.status.replace("_", " ")} plan can't be cancelled here.`);
    await audit(tx, { actorUserId: actor.id, action: "plan.admin_cancelled", entityType: "payment_plan", entityId: planId, metadata: { reason: reason.slice(0, 300) } });
    return r;
  });
}

/**
 * Resolves a plan flagged for reconciliation (a verified payment arrived after
 * the plan ended):
 *  - "refund": refund every unapplied payment and restore the plan's end state;
 *  - "reinstate": re-hold the tickets (if still available) and apply the
 *    payment(s) through the normal once-only path.
 */
export async function adminResolveLatePayment(planId: string, actor: User, action: "refund" | "reinstate") {
  const detail = await adminPlanDetail(planId);
  if (!detail) throw new UserError("Plan not found.");
  if (detail.plan.status !== "reconciliation_required") throw new UserError("This plan doesn't need reconciliation.");
  if (detail.unapplied.length === 0) throw new UserError("No unapplied payments found on this plan.");

  if (action === "refund") {
    await db.transaction(async (tx) => {
      await lockBooking(tx, detail.booking.id);
      for (const p of detail.unapplied) await refundPayment(tx, detail.booking.id, p, "Late plan payment refunded after review", p.amountMinor, actor.id);
      const [{ open }] = await tx
        .select({ open: sql<number>`count(*)::int` })
        .from(refunds)
        .where(and(eq(refunds.bookingId, detail.booking.id), inArray(refunds.status, ["pending", "failed", "manual_required"])));
      await tx
        .update(paymentPlans)
        .set({ status: open > 0 ? "refund_pending" : detail.plan.endReason?.includes("cancel") ? "cancelled" : "expired", reconciliationNote: null, updatedAt: new Date() })
        .where(eq(paymentPlans.id, planId));
      await tx.update(bookings).set({ paymentStatus: "refund_pending", updatedAt: new Date() }).where(eq(bookings.id, detail.booking.id));
      await audit(tx, { actorUserId: actor.id, action: "plan.late_payment_refunded", entityType: "payment_plan", entityId: planId, metadata: { payments: detail.unapplied.map((p) => p.id) } });
    });
    return "Late payment(s) will be refunded.";
  }

  // Reinstate: re-hold inventory, reopen unpaid installments, then apply each payment once.
  await db.transaction(async (tx) => {
    const booking = await lockBooking(tx, detail.booking.id);
    if (!booking) throw new UserError("Booking not found.");
    if (booking.status === "confirmed") throw new UserError("Booking is already confirmed.");
    const [openRefunds] = await tx.select({ n: sql<number>`count(*)::int` }).from(refunds).where(and(eq(refunds.bookingId, booking.id), inArray(refunds.status, ["succeeded", "manual_required"])));
    if (openRefunds.n > 0) throw new UserError("Some payments on this plan were already refunded. Refund the late payment instead.");
    try {
      if (booking.inventoryState === "released") await holdInventory(tx, booking.eventId, await bookingLines(tx, booking.id));
    } catch (err) {
      if (err instanceof InventoryUnavailableError) throw new UserError("Those tickets are no longer available — refund the payment instead.");
      throw err;
    }
    // Pending (not yet sent) refunds from the plan's end are withdrawn.
    await tx.delete(refunds).where(and(eq(refunds.bookingId, booking.id), eq(refunds.status, "pending")));
    await tx
      .update(planInstallments)
      .set({ status: "due", updatedAt: new Date() })
      .where(and(eq(planInstallments.planId, planId), eq(planInstallments.status, "cancelled")));
    await tx
      .update(paymentPlans)
      .set({ status: detail.plan.paidMinor > 0 ? "active" : "awaiting_deposit", endedAt: null, endReason: null, reconciliationNote: null, updatedAt: new Date() })
      .where(eq(paymentPlans.id, planId));
    await tx
      .update(bookings)
      .set({ status: detail.plan.paidMinor > 0 ? "on_plan" : "pending", inventoryState: "held", paymentStatus: detail.plan.paidMinor > 0 ? "partially_paid" : "pending", cancelledAt: null, expiresAt: detail.plan.finalDueAt, updatedAt: new Date() })
      .where(eq(bookings.id, booking.id));
    // Let applyPaymentResult apply them again through the normal path.
    await tx.update(paymentTransactions).set({ status: "pending", updatedAt: new Date() }).where(inArray(paymentTransactions.id, detail.unapplied.map((p) => p.id)));
    await audit(tx, { actorUserId: actor.id, action: "plan.reinstated", entityType: "payment_plan", entityId: planId, metadata: { payments: detail.unapplied.map((p) => p.id) } });
  });
  for (const p of detail.unapplied) {
    await applyPaymentResult(p.id, { status: "succeeded", amountMinor: p.amountMinor, receipt: p.providerReceipt, source: "admin", actorUserId: actor.id, resultDesc: "Re-applied after reconciliation review" });
  }
  return "Plan reinstated and the late payment applied.";
}

/** Status of one installment attempt for the customer's polling page (payment must belong to the booking). */
export async function planPaymentStatus(booking: Booking, paymentId: string) {
  const [plan] = await db.select().from(paymentPlans).where(eq(paymentPlans.bookingId, booking.id));
  const [p] = /^[0-9a-f-]{36}$/i.test(paymentId)
    ? await db
        .select({ status: paymentTransactions.status, failureReason: paymentTransactions.failureReason, amountMinor: paymentTransactions.amountMinor, sequence: planInstallments.sequence })
        .from(paymentTransactions)
        .innerJoin(planInstallments, eq(planInstallments.id, paymentTransactions.installmentId))
        .where(and(eq(paymentTransactions.id, paymentId), eq(paymentTransactions.bookingId, booking.id)))
    : [];
  return {
    payment: p ? { status: p.status, failureReason: p.failureReason, amountMinor: p.amountMinor, isDeposit: p.sequence === 0 } : null,
    planStatus: plan?.status ?? "none",
    bookingStatus: booking.status,
    paidMinor: plan?.paidMinor ?? 0,
    outstandingMinor: plan ? plan.totalMinor - plan.paidMinor : 0,
  };
}

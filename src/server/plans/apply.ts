/**
 * Payment-plan state changes that must happen inside the payment/booking
 * transaction: applying a verified installment payment exactly once, ending a
 * plan (with inventory release and transparent refunds) and the periodic sweep
 * that marks installments due/overdue, sends reminders and expires plans.
 *
 * Separation of state: payment_transactions.status is the M-Pesa attempt,
 * plan_installments.status the schedule line, payment_plans.status the plan.
 */
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  bookings,
  events,
  paymentPlans,
  paymentTransactions,
  planInstallments,
  refunds,
  type Booking,
  type PaymentPlan,
  type PaymentTransaction,
  type PlanInstallment,
} from "@/db/schema";
import { audit } from "../audit";
import { bookingLines, confirmBooking } from "../bookings/lifecycle";
import { queueEmail } from "../email/queue";
import { holdInventory, InventoryUnavailableError, releaseHeldInventory } from "../inventory";
import { enqueueJob } from "../jobs/queue";
import type { PaymentResult } from "../payments/service";
import { DEFAULT_PLAN_POLICY, refundableOnEnd, type PlanPolicy } from "./policy";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ENDED = new Set(["cancelled", "expired", "refund_pending", "refunded", "reconciliation_required"]);
const UNPAID = ["scheduled", "due", "failed", "overdue"] as const;
/** Payment states that mean "an answer may still come": never end a plan or start another charge meanwhile. */
const UNRESOLVED_PAYMENT = ["created", "pending", "reconciliation_required"] as const;

export const planPolicyOf = (plan: PaymentPlan): PlanPolicy => ({ ...DEFAULT_PLAN_POLICY, ...((plan.policy as Partial<PlanPolicy>) ?? {}) });

async function lockPlan(tx: Tx, bookingId: string) {
  const [p] = await tx.select().from(paymentPlans).where(eq(paymentPlans.bookingId, bookingId)).for("update");
  return p ?? null;
}

/**
 * Called by applyPaymentResult (row locks on the payment and booking held) for
 * attempts that pay a plan installment.
 */
export async function applyPlanPaymentResult(
  tx: Tx,
  a: { payment: PaymentTransaction; booking: Booking; r: PaymentResult; now: Date; providerFields: Record<string, unknown> },
): Promise<string> {
  const { payment, r, now } = a;
  let booking = a.booking;
  const plan = await lockPlan(tx, booking.id);
  const [inst] = await tx.select().from(planInstallments).where(eq(planInstallments.id, payment.installmentId!)).for("update");
  if (!plan || !inst || inst.planId !== plan.id) {
    // Should be impossible (FKs): keep the money visible to an operator rather than guess.
    await tx
      .update(paymentTransactions)
      .set({ status: "reconciliation_required", failureReason: "Installment payment does not match a plan", nextStatusCheckAt: null, updatedAt: now })
      .where(eq(paymentTransactions.id, payment.id));
    await audit(tx, { action: "plan.payment_unmatched", entityType: "payment", entityId: payment.id, metadata: { source: r.source } });
    return "plan_payment_unmatched_flagged";
  }

  // ── failure / cancellation / timeout ──
  if (r.status !== "succeeded") {
    if (payment.status === "succeeded" || payment.status === "refunded") return "ignored_after_success";
    await tx
      .update(paymentTransactions)
      .set({ ...a.providerFields, status: r.status, failureReason: r.failureReason ?? null, completedAt: now })
      .where(eq(paymentTransactions.id, payment.id));
    if (inst.status === "payment_pending") {
      await tx
        .update(planInstallments)
        .set({ status: inst.dueAt < now && inst.sequence > 0 ? "overdue" : "failed", updatedAt: now })
        .where(eq(planInstallments.id, inst.id));
    }
    if (booking.status === "pending") await tx.update(bookings).set({ paymentStatus: "failed", updatedAt: now }).where(eq(bookings.id, booking.id));
    if (r.source !== "webhook" && !ENDED.has(plan.status)) {
      await queueEmail(tx, {
        kind: "plan_payment_failed",
        toEmail: booking.buyerEmail,
        bookingId: booking.id,
        eventId: booking.eventId,
        dedupeKey: `plan_payment_failed:${payment.id}`,
        metadata: { installmentId: inst.id, reason: (r.failureReason ?? "the payment was not completed").slice(0, 200) },
      });
    }
    await audit(tx, {
      actorUserId: r.actorUserId,
      action: `payment.${r.status}`,
      entityType: "payment",
      entityId: payment.id,
      metadata: { from: payment.status, source: r.source, planId: plan.id, installment: inst.sequence },
    });
    return `installment_payment_${r.status}`;
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
    .set({ ...a.providerFields, status: "succeeded", providerReceipt: r.receipt ?? payment.providerReceipt, failureReason: null, completedAt: now })
    .where(eq(paymentTransactions.id, payment.id));
  await audit(tx, {
    actorUserId: r.actorUserId,
    action: "payment.succeeded",
    entityType: "payment",
    entityId: payment.id,
    metadata: { from: payment.status, source: r.source, receipt: r.receipt ?? null, amountMinor: payment.amountMinor, planId: plan.id, installment: inst.sequence },
  });

  // The same installment was already settled by another payment → refund this one.
  if (inst.status === "paid") {
    await refundPayment(tx, booking.id, payment, "Duplicate payment for an installment that was already paid");
    return "duplicate_installment_payment_refunded";
  }

  // A deposit that arrives after the checkout hold lapsed: honour it if the tickets can be re-held.
  const lateDeposit =
    inst.sequence === 0 && plan.paidMinor === 0 && (plan.status === "expired" || plan.status === "cancelled") && (booking.status === "expired" || booking.status === "cancelled");
  if (lateDeposit && plan.finalDueAt > now) {
    const [ev] = await tx.select({ status: events.status }).from(events).where(eq(events.id, booking.eventId));
    try {
      if (ev?.status !== "published") throw new InventoryUnavailableError("Event is no longer on sale");
      await tx.transaction(async (sp) => {
        await holdInventory(sp, booking.eventId, await bookingLines(sp, booking.id));
        await sp.update(bookings).set({ status: "pending", inventoryState: "held", cancelledAt: null, updatedAt: now }).where(eq(bookings.id, booking.id));
        await sp
          .update(planInstallments)
          .set({ status: "scheduled", updatedAt: now })
          .where(and(eq(planInstallments.planId, plan.id), eq(planInstallments.status, "cancelled")));
      });
      booking = { ...booking, status: "pending", inventoryState: "held" };
      plan.status = "awaiting_deposit";
      await audit(tx, { action: "plan.late_deposit_reinstated", entityType: "payment_plan", entityId: plan.id, metadata: { paymentId: payment.id } });
    } catch (err) {
      if (!(err instanceof InventoryUnavailableError)) throw err;
      return flagLatePayment(tx, plan, booking, payment, "Deposit received after the reservation lapsed and the tickets are no longer available");
    }
  } else if (ENDED.has(plan.status) || !["pending", "on_plan"].includes(booking.status)) {
    return flagLatePayment(tx, plan, booking, payment, `Installment payment received while the plan was ${plan.status}`);
  }

  const paidMinor = plan.paidMinor + inst.amountMinor;
  if (paidMinor > plan.totalMinor) {
    return flagLatePayment(tx, plan, booking, payment, "Payment would exceed the plan total");
  }
  await tx
    .update(planInstallments)
    .set({ status: "paid", paidAt: now, paymentTransactionId: payment.id, updatedAt: now })
    .where(eq(planInstallments.id, inst.id));

  const fullyPaid = paidMinor === plan.totalMinor;
  const activating = plan.status === "awaiting_deposit";
  await tx
    .update(paymentPlans)
    .set({
      paidMinor,
      status: fullyPaid ? "fully_paid" : "active",
      ...(activating ? { activatedAt: now, endedAt: null, endReason: null } : {}),
      ...(fullyPaid ? { completedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(paymentPlans.id, plan.id));

  if (activating || booking.status === "pending") {
    // Deposit verified: the hold now lasts until the final deadline (inventory stays "held").
    const [b] = await tx
      .update(bookings)
      .set({ status: "on_plan", paymentStatus: "partially_paid", expiresAt: plan.finalDueAt, updatedAt: now })
      .where(eq(bookings.id, booking.id))
      .returning();
    booking = b;
  }
  await audit(tx, {
    action: fullyPaid ? "plan.fully_paid" : activating ? "plan.activated" : "plan.installment_paid",
    entityType: "payment_plan",
    entityId: plan.id,
    metadata: { paymentId: payment.id, installment: inst.sequence, amountMinor: inst.amountMinor, paidMinor, totalMinor: plan.totalMinor },
  });

  if (fullyPaid) {
    // Tickets, ledger, PDF email and organizer notification — exactly once (confirmBooking is idempotent).
    await confirmBooking(tx, booking, { free: false });
    return "plan_fully_paid_booking_confirmed";
  }
  await queueEmail(tx, {
    kind: activating ? "plan_deposit_confirmed" : "plan_payment_confirmed",
    toEmail: booking.buyerEmail,
    bookingId: booking.id,
    eventId: booking.eventId,
    dedupeKey: `${activating ? "plan_deposit_confirmed" : "plan_payment_confirmed"}:${inst.id}`,
    metadata: { installmentId: inst.id },
  });
  await refreshInstallmentStatuses(tx, plan, now);
  return activating ? "plan_activated" : "installment_paid";
}

/** A verified payment that can't be applied: keep the money visible, never issue tickets, let an admin decide. */
async function flagLatePayment(tx: Tx, plan: PaymentPlan, booking: Booking, payment: PaymentTransaction, note: string) {
  await tx
    .update(paymentPlans)
    .set({ status: "reconciliation_required", reconciliationNote: note.slice(0, 300), updatedAt: new Date() })
    .where(eq(paymentPlans.id, plan.id));
  await audit(tx, { action: "plan.late_payment_flagged", entityType: "payment_plan", entityId: plan.id, metadata: { paymentId: payment.id, amountMinor: payment.amountMinor, previousStatus: plan.status, note } });
  await queueEmail(tx, {
    kind: "plan_payment_review",
    toEmail: booking.buyerEmail,
    bookingId: booking.id,
    eventId: booking.eventId,
    dedupeKey: `plan_payment_review:${payment.id}`,
    metadata: { paymentId: payment.id },
  });
  return "plan_late_payment_flagged";
}

async function refundPayment(tx: Tx, bookingId: string, payment: Pick<PaymentTransaction, "id" | "amountMinor">, reason: string, amountMinor = payment.amountMinor, actorUserId?: string) {
  const [refund] = await tx
    .insert(refunds)
    .values({ bookingId, paymentTransactionId: payment.id, amountMinor, reason, initiatedBy: actorUserId ?? null })
    .returning();
  await enqueueJob(tx, "refund.process", { refundId: refund.id }, { dedupeKey: `refund:${refund.id}` });
  return refund;
}

export type PlanEndReason = "missed_installment" | "deadline_passed" | "customer_cancelled" | "admin_cancelled" | "event_cancelled";

/**
 * Ends an unfinished plan: releases the held tickets, cancels unpaid
 * installments and refunds what was paid (minus the agreed fee, which is 0 by
 * default and always 0 for event/admin cancellations). Caller locks the booking.
 */
export async function endPlan(tx: Tx, bookingId: string, reason: PlanEndReason, actorUserId?: string) {
  const plan = await lockPlan(tx, bookingId);
  if (!plan || !["awaiting_deposit", "active"].includes(plan.status)) return null;
  const [booking] = await tx.select().from(bookings).where(eq(bookings.id, bookingId)).for("update");
  const now = new Date();

  if (booking.inventoryState === "held") await releaseHeldInventory(tx, await bookingLines(tx, booking.id));
  await tx
    .update(planInstallments)
    .set({ status: "cancelled", updatedAt: now })
    .where(and(eq(planInstallments.planId, plan.id), notInArray(planInstallments.status, ["paid"])));

  const { refundMinor, retainedMinor } = refundableOnEnd(plan.paidMinor, plan.cancellationFeeMinor, reason);
  const refundIds: string[] = [];
  if (refundMinor > 0) {
    // Refund newest payments first; any retained fee comes out of the earliest one(s).
    const paid = await tx
      .select({ id: paymentTransactions.id, amountMinor: paymentTransactions.amountMinor })
      .from(planInstallments)
      .innerJoin(paymentTransactions, eq(paymentTransactions.id, planInstallments.paymentTransactionId))
      .where(and(eq(planInstallments.planId, plan.id), eq(planInstallments.status, "paid")))
      .orderBy(sql`${planInstallments.sequence} desc`);
    let left = refundMinor;
    for (const p of paid) {
      if (left <= 0) break;
      const amt = Math.min(left, p.amountMinor);
      refundIds.push((await refundPayment(tx, booking.id, p, `Payment plan ended (${reason.replace("_", " ")})`, amt, actorUserId)).id);
      left -= amt;
    }
  }

  const customerSide = reason === "customer_cancelled" || reason === "admin_cancelled" || reason === "event_cancelled";
  const status = refundMinor > 0 ? "refund_pending" : customerSide ? "cancelled" : "expired";
  await tx.update(paymentPlans).set({ status, endedAt: now, endReason: reason, updatedAt: now }).where(eq(paymentPlans.id, plan.id));
  await tx
    .update(bookings)
    .set({
      status: customerSide ? "cancelled" : "expired",
      inventoryState: "released",
      paymentStatus: refundMinor > 0 ? "refund_pending" : booking.paymentStatus === "partially_paid" ? "unpaid" : booking.paymentStatus,
      cancelledAt: now,
      updatedAt: now,
    })
    .where(eq(bookings.id, booking.id));
  if (plan.status === "active" || plan.paidMinor > 0) {
    await queueEmail(tx, {
      kind: "plan_ended",
      toEmail: booking.buyerEmail,
      bookingId: booking.id,
      eventId: booking.eventId,
      dedupeKey: `plan_ended:${plan.id}`,
      metadata: { reason, refundMinor, retainedMinor },
    });
  }
  await audit(tx, {
    actorUserId,
    action: "plan.ended",
    entityType: "payment_plan",
    entityId: plan.id,
    metadata: { reason, paidMinor: plan.paidMinor, refundMinor, retainedMinor, refundIds, previousStatus: plan.status },
  });
  return { status, refundMinor, retainedMinor };
}

/** Recomputes scheduled/due/overdue for unpaid installments; returns the ones that changed. */
async function refreshInstallmentStatuses(tx: Tx, plan: PaymentPlan, now: Date) {
  const policy = planPolicyOf(plan);
  const rows = await tx
    .select()
    .from(planInstallments)
    .where(and(eq(planInstallments.planId, plan.id), inArray(planInstallments.status, [...UNPAID])))
    .orderBy(asc(planInstallments.sequence));
  const changed: { inst: PlanInstallment; to: "due" | "overdue" }[] = [];
  for (const i of rows) {
    const dueSoon = i.dueAt.getTime() - policy.reminderDaysBefore * DAY <= now.getTime();
    // A failed attempt stays "failed" (payable) until the due date passes.
    const to = i.dueAt < now ? "overdue" : i.status === "failed" ? "failed" : dueSoon ? "due" : "scheduled";
    if (to === i.status) continue;
    await tx.update(planInstallments).set({ status: to, updatedAt: now }).where(eq(planInstallments.id, i.id));
    if (to === "due" || to === "overdue") changed.push({ inst: i, to });
  }
  return changed;
}

/**
 * Worker step (every tick; cheap when nothing is due): installment status,
 * reminders (deduplicated per installment), the final-deadline warning and
 * expiry of plans with missed payments. Never ends a plan while one of its
 * payments may still succeed.
 */
export async function runPlanMaintenance(now = new Date(), limit = 100) {
  const candidates = await db
    .select({ id: paymentPlans.id, bookingId: paymentPlans.bookingId })
    .from(paymentPlans)
    .where(
      and(
        eq(paymentPlans.status, "active"),
        sql`exists (select 1 from ${planInstallments} i where i.plan_id = ${paymentPlans.id} and i.status in ('scheduled','due','failed','overdue')
             and i.due_at <= ${new Date(now.getTime() + 15 * DAY)})`,
      ),
    )
    .orderBy(asc(paymentPlans.finalDueAt))
    .limit(limit);
  let ended = 0;
  for (const c of candidates) {
    const result = await db.transaction(async (tx) => {
      const [booking] = await tx.select().from(bookings).where(eq(bookings.id, c.bookingId)).for("update", { skipLocked: true });
      if (!booking) return null;
      const [plan] = await tx.select().from(paymentPlans).where(eq(paymentPlans.id, c.id)).for("update");
      if (!plan || plan.status !== "active") return null;
      const policy = planPolicyOf(plan);

      for (const { inst, to } of await refreshInstallmentStatuses(tx, plan, now)) {
        await queueEmail(tx, {
          kind: to === "due" ? "plan_installment_due" : "plan_installment_overdue",
          toEmail: booking.buyerEmail,
          bookingId: booking.id,
          eventId: booking.eventId,
          dedupeKey: `plan_installment_${to}:${inst.id}`,
          metadata: { installmentId: inst.id },
        });
      }
      const outstanding = plan.totalMinor - plan.paidMinor;
      if (outstanding > 0 && plan.finalDueAt.getTime() - 48 * HOUR <= now.getTime() && plan.finalDueAt > now) {
        await queueEmail(tx, {
          kind: "plan_final_deadline",
          toEmail: booking.buyerEmail,
          bookingId: booking.id,
          eventId: booking.eventId,
          dedupeKey: `plan_final_deadline:${plan.id}`,
        });
      }

      const unresolved = await tx.$count(
        paymentTransactions,
        and(eq(paymentTransactions.bookingId, booking.id), inArray(paymentTransactions.status, [...UNRESOLVED_PAYMENT])),
      );
      if (unresolved > 0) return null;
      if (outstanding > 0 && plan.finalDueAt <= now) return endPlan(tx, booking.id, "deadline_passed");
      const [missed] = await tx
        .select({ id: planInstallments.id })
        .from(planInstallments)
        .where(
          and(
            eq(planInstallments.planId, plan.id),
            eq(planInstallments.status, "overdue"),
            sql`${planInstallments.dueAt} + make_interval(hours => ${policy.overdueGraceHours}) < ${now}`,
          ),
        )
        .limit(1);
      if (missed) return endPlan(tx, booking.id, "missed_installment");
      return null;
    });
    if (result) ended++;
  }
  return { checked: candidates.length, ended };
}

/** When every refund for an ended plan has settled. Called after a refund completes. */
export async function finalizePlanRefunds(bookingId: string) {
  const open = await db.$count(refunds, and(eq(refunds.bookingId, bookingId), inArray(refunds.status, ["pending", "failed", "manual_required"])));
  if (open > 0) return;
  await db
    .update(paymentPlans)
    .set({ status: "refunded", updatedAt: new Date() })
    .where(and(eq(paymentPlans.bookingId, bookingId), eq(paymentPlans.status, "refund_pending")));
}

/** For admin resolution: verified payments on this plan that were never applied to an installment. */
export async function unappliedPlanPayments(tx: Tx, planId: string) {
  return tx
    .select({ p: paymentTransactions })
    .from(paymentTransactions)
    .innerJoin(planInstallments, eq(planInstallments.id, paymentTransactions.installmentId))
    .where(
      and(
        eq(planInstallments.planId, planId),
        eq(paymentTransactions.status, "succeeded"),
        sql`(${planInstallments.paymentTransactionId} is distinct from ${paymentTransactions.id})`,
        sql`not exists (select 1 from ${refunds} r where r.payment_transaction_id = ${paymentTransactions.id})`,
      ),
    );
}

export { refundPayment };

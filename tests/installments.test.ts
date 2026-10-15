/**
 * Lipa Mdogo Mdogo (installment plans). Uses the simulated payment provider
 * (signed mock webhooks) — no real M-Pesa requests are made.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { bookings, emailDeliveries, events, paymentPlans, paymentTransactions, planInstallments, refunds, ticketTypes, tickets, type Booking } from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { cancelEvent } from "@/server/bookings/refunds";
import { expireStaleBookings } from "@/server/bookings/lifecycle";
import { setEmailTransportOverride } from "@/server/email/transport";
import { processDueJobs } from "@/server/jobs/queue";
import { applyPaymentResult } from "@/server/payments/service";
import { runPlanMaintenance } from "@/server/plans/apply";
import { DEFAULT_PLAN_POLICY, planOptions, quotePlan, setPlanPolicy, splitAmounts } from "@/server/plans/policy";
import {
  adminResolveLatePayment,
  cancelPlanByCustomer,
  createPlan,
  organizerPlans,
  planOfferForBooking,
  startPlanPayment,
} from "@/server/plans/service";
import { checkout, failingTransport, makeEvent, makeOrganizer, makeUser, memoryTransport, resetDb, sendCallback, sentEmails } from "./helpers";

const DAY = 86_400_000;

async function planEvent(opts: { priceKes?: number; capacity?: number; daysOut?: number; enabled?: boolean } = {}) {
  const { organizer, user } = await makeOrganizer();
  const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: opts.priceKes ?? 1500, capacity: opts.capacity ?? 50 }]);
  const startsAt = new Date(Date.now() + (opts.daysOut ?? 30) * DAY);
  const [ev] = await db
    .update(events)
    .set({ startsAt, endsAt: new Date(startsAt.getTime() + 4 * 3600_000), installmentsEnabled: opts.enabled ?? true })
    .where(eq(events.id, event.id))
    .returning();
  return { event: ev, tt, organizer, organizerUser: user };
}

const reload = async (id: string) => (await db.select().from(bookings).where(eq(bookings.id, id)))[0];
const planOf = async (bookingId: string) => (await db.select().from(paymentPlans).where(eq(paymentPlans.bookingId, bookingId)))[0];
const installmentsOf = async (planId: string) => db.select().from(planInstallments).where(eq(planInstallments.planId, planId)).orderBy(planInstallments.sequence);
const ttRow = async (id: string) => (await db.select().from(ticketTypes).where(eq(ticketTypes.id, id)))[0];
const kinds = () => sentEmails.map((m) => String(m.tags?.kind ?? ""));

/** Sends the next installment request and settles it with a signed (simulated) provider webhook. */
async function payNext(booking: Booking, outcome: "succeeded" | "failed" = "succeeded") {
  const res = await startPlanPayment({ booking: await reload(booking.id), payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
  const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, res.paymentId));
  const outcomeRes = await sendCallback(p.providerReference!, outcome, p.amountMinor);
  return { payment: p, outcome: outcomeRes.outcome };
}

async function startPlan(eventId: string, ttId: string, qty = 2, n = 3) {
  const booking = await checkout(eventId, [[ttId, qty]]);
  await createPlan({ booking, installmentCount: n, acceptedTerms: true });
  return booking;
}

beforeEach(async () => {
  await resetDb();
  setEmailTransportOverride(memoryTransport);
});
afterEach(() => setEmailTransportOverride(memoryTransport));

describe("schedule maths", () => {
  it("splits KES 3,000 at 30% into 900 + 700 × 3", () => {
    expect(splitAmounts(300_000, 3000, 3)).toEqual({ depositMinor: 90_000, installmentsMinor: [70_000, 70_000, 70_000] });
  });

  it("rounds the deposit up and lets the last installment absorb the remainder", () => {
    expect(splitAmounts(100_000, 3000, 3)).toEqual({ depositMinor: 30_000, installmentsMinor: [23_300, 23_300, 23_400] });
    expect(splitAmounts(100_100, 3000, 3)).toEqual({ depositMinor: 30_100, installmentsMinor: [23_300, 23_300, 23_400] });
  });

  it("always adds up exactly, in whole shillings", () => {
    for (let kes = 500; kes < 20_000; kes += 37) {
      for (const n of [1, 2, 3, 4, 5, 6]) {
        const { depositMinor, installmentsMinor } = splitAmounts(kes * 100, 3000, n);
        expect(depositMinor + installmentsMinor.reduce((a, b) => a + b, 0)).toBe(kes * 100);
        expect(depositMinor).toBeGreaterThanOrEqual(Math.ceil(kes * 100 * 0.3));
        for (const a of [depositMinor, ...installmentsMinor]) expect(a % 100).toBe(0);
      }
    }
  });

  it("schedules the last installment exactly at the final deadline (48 h before the event)", () => {
    const now = new Date("2026-11-01T09:00:00Z");
    const starts = new Date("2026-11-30T18:00:00Z");
    const q = quotePlan({ totalMinor: 300_000, eventStartsAt: starts, policy: DEFAULT_PLAN_POLICY, installmentCount: 3, now });
    if ("eligible" in q) throw new Error(q.reason);
    expect(q.finalDueAt.toISOString()).toBe("2026-11-28T18:00:00.000Z");
    expect(q.lines.map((l) => l.sequence)).toEqual([0, 1, 2, 3]);
    expect(q.lines[3].dueAt.getTime()).toBe(q.finalDueAt.getTime());
    expect(q.lines[1].dueAt < q.lines[2].dueAt && q.lines[2].dueAt < q.lines[3].dueAt).toBe(true);
  });

  it("refuses events that are too close, too-small orders and impossible schedules", () => {
    const now = new Date();
    const base = { policy: DEFAULT_PLAN_POLICY, now, installmentCount: 3 };
    expect(quotePlan({ ...base, totalMinor: 300_000, eventStartsAt: new Date(now.getTime() + 6 * DAY) })).toMatchObject({ eligible: false });
    expect(quotePlan({ ...base, totalMinor: 20_000, eventStartsAt: new Date(now.getTime() + 30 * DAY) })).toMatchObject({ eligible: false });
    const tight = planOptions({ totalMinor: 300_000, eventStartsAt: new Date(now.getTime() + 8 * DAY), policy: { ...DEFAULT_PLAN_POLICY, minDaysBetweenPayments: 2.5 }, now });
    expect(tight.options.map((o) => o.installmentCount)).toEqual([1, 2]);
  });
});

describe("eligibility & creation", () => {
  it("is only offered when the organizer opted in", async () => {
    const { event, tt } = await planEvent({ enabled: false });
    const booking = await checkout(event.id, [[tt.id, 2]]);
    expect(await planOfferForBooking(booking, event)).toMatchObject({ available: false });
    await expect(createPlan({ booking, installmentCount: 3, acceptedTerms: true })).rejects.toThrow(/aren't available/);
  });

  it("requires accepted terms and stores the schedule, policy snapshot and terms version", async () => {
    const { event, tt } = await planEvent();
    const booking = await checkout(event.id, [[tt.id, 2]]);
    await expect(createPlan({ booking, installmentCount: 3, acceptedTerms: false })).rejects.toThrow(/accept/);
    const plan = await createPlan({ booking, installmentCount: 3, acceptedTerms: true });
    expect(plan).toMatchObject({ status: "awaiting_deposit", totalMinor: 300_000, depositMinor: 90_000, installmentCount: 3, paidMinor: 0 });
    expect((plan.policy as { depositBps: number }).depositBps).toBe(3000);
    const lines = await installmentsOf(plan.id);
    expect(lines.map((l) => l.amountMinor)).toEqual([90_000, 70_000, 70_000, 70_000]);
  });

  it("price and policy changes never alter an accepted schedule", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const admin = await makeUser("admin");
    await setPlanPolicy({ ...DEFAULT_PLAN_POLICY, depositBps: 5000 }, admin);
    await db.update(ticketTypes).set({ priceMinor: 999_900 }).where(eq(ticketTypes.id, tt.id));
    await payNext(booking);
    const plan = await planOf(booking.id);
    expect(plan.depositMinor).toBe(90_000);
    expect((await installmentsOf(plan.id)).map((l) => l.amountMinor)).toEqual([90_000, 70_000, 70_000, 70_000]);
  });
});

describe("paying a plan", () => {
  it("deposit verified → plan active, tickets held but NOT issued", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const { payment, outcome } = await payNext(booking);
    expect(payment.amountMinor).toBe(90_000);
    expect(payment.installmentId).not.toBeNull();
    expect(outcome).toBe("plan_activated");

    const plan = await planOf(booking.id);
    expect(plan).toMatchObject({ status: "active", paidMinor: 90_000 });
    const b = await reload(booking.id);
    expect(b).toMatchObject({ status: "on_plan", paymentStatus: "partially_paid", inventoryState: "held" });
    expect(b.expiresAt.getTime()).toBe(plan.finalDueAt.getTime());
    expect(await ttRow(tt.id)).toMatchObject({ reserved: 2, sold: 0 });
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);
    await processDueJobs(20);
    expect(kinds()).toContain("plan_deposit_confirmed");
    expect(kinds()).not.toContain("booking_confirmation");
  });

  it("an accepted STK request alone never marks an installment paid", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const res = await startPlanPayment({ booking, payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    const [inst] = (await installmentsOf((await planOf(booking.id)).id)).filter((i) => i.sequence === 0);
    expect(inst.status).toBe("payment_pending");
    expect((await planOf(booking.id)).paidMinor).toBe(0);
    const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, res.paymentId));
    expect(p.status).toBe("pending");
  });

  it("applies a duplicated callback exactly once", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const res = await startPlanPayment({ booking, payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, res.paymentId));
    const first = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_dup_1" });
    const again = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_dup_1" });
    const other = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_dup_2" });
    expect(first.outcome).toBe("plan_activated");
    expect(again.outcome).toBe("duplicate_ignored");
    expect(other.outcome).toBe("already_succeeded");
    expect((await planOf(booking.id)).paidMinor).toBe(90_000);
  });

  it("re-submitting while a request is in flight returns the same attempt (no second charge)", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const a = await startPlanPayment({ booking, payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    const b = await startPlanPayment({ booking, payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    expect(b.paymentId).toBe(a.paymentId);
    expect(await db.$count(paymentTransactions, eq(paymentTransactions.bookingId, booking.id))).toBe(1);
  });

  it("a failed installment leaves the plan active and payable again", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    await payNext(booking);
    const failed = await payNext(booking, "failed");
    expect(failed.outcome).toBe("installment_payment_failed");
    const plan = await planOf(booking.id);
    expect(plan).toMatchObject({ status: "active", paidMinor: 90_000 });
    expect((await installmentsOf(plan.id))[1].status).toBe("failed");
    const retry = await payNext(booking);
    expect(retry.outcome).toBe("installment_paid");
    expect((await planOf(booking.id)).paidMinor).toBe(160_000);
  });

  it("full balance verified → tickets, ledger and PDF email issued exactly once", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push((await payNext(booking)).outcome);
    expect(outcomes).toEqual(["plan_activated", "installment_paid", "installment_paid", "plan_fully_paid_booking_confirmed"]);
    expect(await planOf(booking.id)).toMatchObject({ status: "fully_paid", paidMinor: 300_000 });
    expect(await reload(booking.id)).toMatchObject({ status: "confirmed", paymentStatus: "paid", inventoryState: "committed" });
    expect(await ttRow(tt.id)).toMatchObject({ reserved: 0, sold: 2 });
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(2);
    await expect(startPlanPayment({ booking: await reload(booking.id), payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" })).rejects.toThrow(/fully paid/);

    await processDueJobs(30);
    const conf = sentEmails.filter((m) => m.tags?.kind === "booking_confirmation");
    expect(conf).toHaveLength(1);
    expect(conf[0].attachments?.[0]?.contentType).toBe("application/pdf");
    expect(conf[0].text).toContain("Lipa Mdogo Mdogo plan is fully paid");
  });

  it("holds plan inventory atomically so it can't be oversold", async () => {
    const { event, tt } = await planEvent({ capacity: 2 });
    const booking = await startPlan(event.id, tt.id, 2);
    await payNext(booking);
    await expect(checkout(event.id, [[tt.id, 1]])).rejects.toThrow(/sold out/i);
  });

  it("email failures never change payment or plan state", async () => {
    setEmailTransportOverride(failingTransport);
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    await payNext(booking);
    await processDueJobs(20);
    expect(await planOf(booking.id)).toMatchObject({ status: "active", paidMinor: 90_000 });
    const [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "plan_deposit_confirmed")));
    expect(["retry_pending", "failed"]).toContain(d.status);
  });
});

describe("missed payments, expiry, cancellation & refunds", () => {
  async function activePlan(opts: Parameters<typeof planEvent>[0] = {}) {
    const ctx = await planEvent(opts);
    const booking = await startPlan(ctx.event.id, ctx.tt.id);
    await payNext(booking);
    const plan = await planOf(booking.id);
    return { ...ctx, booking, plan, lines: await installmentsOf(plan.id) };
  }

  it("marks installments due (one reminder) and overdue", async () => {
    const { booking, lines } = await activePlan();
    await db.update(planInstallments).set({ dueAt: new Date(Date.now() + 2 * DAY) }).where(eq(planInstallments.id, lines[1].id));
    await runPlanMaintenance();
    await runPlanMaintenance();
    expect((await installmentsOf(lines[1].planId))[1].status).toBe("due");
    expect(await db.$count(emailDeliveries, and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "plan_installment_due")))).toBe(1);

    await db.update(planInstallments).set({ dueAt: new Date(Date.now() - 3600_000) }).where(eq(planInstallments.id, lines[1].id));
    await runPlanMaintenance();
    expect((await installmentsOf(lines[1].planId))[1].status).toBe("overdue");
    expect(await db.$count(emailDeliveries, and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "plan_installment_overdue")))).toBe(1);
    expect((await planOf(booking.id)).status).toBe("active"); // still within the grace period
  });

  it("past the grace period: plan ends, tickets released, everything paid refunded", async () => {
    const { booking, tt, lines } = await activePlan();
    await db.update(planInstallments).set({ dueAt: new Date(Date.now() - 4 * DAY) }).where(eq(planInstallments.id, lines[1].id));
    const r = await runPlanMaintenance();
    expect(r.ended).toBe(1);
    expect(await planOf(booking.id)).toMatchObject({ status: "refund_pending", endReason: "missed_installment" });
    expect(await reload(booking.id)).toMatchObject({ status: "expired", inventoryState: "released", paymentStatus: "refund_pending" });
    expect(await ttRow(tt.id)).toMatchObject({ reserved: 0, sold: 0 });
    const rs = await db.select().from(refunds).where(eq(refunds.bookingId, booking.id));
    expect(rs.reduce((s, x) => s + x.amountMinor, 0)).toBe(90_000);
    expect((await installmentsOf(lines[0].planId)).slice(1).every((i) => i.status === "cancelled")).toBe(true);

    await processDueJobs(30); // refund job (simulated provider) → queues the refund email
    await processDueJobs(30);
    expect((await planOf(booking.id)).status).toBe("refunded");
    expect(kinds()).toEqual(expect.arrayContaining(["plan_ended", "refund_completed"]));
  });

  it("never expires a plan while a payment might still succeed (delayed callback)", async () => {
    const { booking, lines } = await activePlan();
    await startPlanPayment({ booking: await reload(booking.id), payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    await db.update(planInstallments).set({ dueAt: new Date(Date.now() - 5 * DAY) }).where(eq(planInstallments.id, lines[1].id));
    await runPlanMaintenance();
    expect((await planOf(booking.id)).status).toBe("active");
  });

  it("a payment verified after the plan ended is flagged, never ticketed, then resolved by an admin", async () => {
    const { booking, lines } = await activePlan();
    const res = await startPlanPayment({ booking: await reload(booking.id), payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, res.paymentId));
    // The prompt went unanswered for days; it was recorded as expired and the plan ended.
    await applyPaymentResult(p.id, { status: "expired", amountMinor: null, source: "status_query" });
    await db.update(planInstallments).set({ dueAt: new Date(Date.now() - 5 * DAY) }).where(eq(planInstallments.id, lines[1].id));
    await runPlanMaintenance();
    expect((await planOf(booking.id)).status).toBe("refund_pending");

    // …then M-Pesa reports it as paid after all.
    const late = await applyPaymentResult(p.id, { status: "succeeded", amountMinor: p.amountMinor, receipt: "LATE123456", source: "callback" });
    expect(late).toBe("plan_late_payment_flagged");
    const plan = await planOf(booking.id);
    expect(plan.status).toBe("reconciliation_required");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);

    const admin = await makeUser("admin");
    await adminResolveLatePayment(plan.id, admin, "refund");
    const rs = await db.select().from(refunds).where(and(eq(refunds.bookingId, booking.id), eq(refunds.paymentTransactionId, p.id)));
    expect(rs).toHaveLength(1);
    expect(rs[0].amountMinor).toBe(p.amountMinor);
  });

  it("a late deposit after the checkout hold lapsed is honoured if the tickets are still free", async () => {
    const { event, tt } = await planEvent();
    const booking = await startPlan(event.id, tt.id);
    const res = await startPlanPayment({ booking, payerPhone: "254712345678", idempotencyKey: `i-${randomToken(12)}`, returnUrl: "/" });
    await db.update(bookings).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(bookings.id, booking.id));
    await expireStaleBookings();
    expect((await planOf(booking.id)).status).toBe("expired");
    const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, res.paymentId));
    await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
    expect(await planOf(booking.id)).toMatchObject({ status: "active", paidMinor: 90_000, endReason: null });
    expect(await reload(booking.id)).toMatchObject({ status: "on_plan", inventoryState: "held" });
    expect(await ttRow(tt.id)).toMatchObject({ reserved: 2 });
  });

  it("customer cancellation refunds per the accepted terms (with a fee when the policy has one)", async () => {
    const admin = await makeUser("admin");
    await setPlanPolicy({ ...DEFAULT_PLAN_POLICY, cancellationFeeBps: 1000 }, admin);
    const { booking } = await activePlan();
    const plan = await planOf(booking.id);
    expect(plan.cancellationFeeMinor).toBe(30_000);
    const r = await cancelPlanByCustomer(booking.id, null);
    expect(r).toMatchObject({ refundMinor: 60_000, retainedMinor: 30_000, status: "refund_pending" });
    expect((await reload(booking.id)).status).toBe("cancelled");
  });

  it("event cancellation refunds an active plan in full (no fee)", async () => {
    const admin = await makeUser("admin");
    await setPlanPolicy({ ...DEFAULT_PLAN_POLICY, cancellationFeeBps: 1000 }, admin);
    const { booking, event } = await activePlan();
    await cancelEvent({ eventId: event.id, actorUserId: admin.id, reason: "Venue unavailable" });
    expect(await planOf(booking.id)).toMatchObject({ status: "refund_pending", endReason: "event_cancelled" });
    const rs = await db.select().from(refunds).where(eq(refunds.bookingId, booking.id));
    expect(rs.reduce((s, x) => s + x.amountMinor, 0)).toBe(90_000);
  });
});

describe("organizer views", () => {
  it("only show plans for the organizer's own events", async () => {
    const a = await planEvent();
    const b = await planEvent();
    const booking = await startPlan(a.event.id, a.tt.id);
    await payNext(booking);
    expect((await organizerPlans(a.organizer.id)).rows).toHaveLength(1);
    expect((await organizerPlans(a.organizer.id)).stats).toMatchObject({ active: 1, collectedMinor: 90_000, outstandingMinor: 210_000 });
    expect((await organizerPlans(b.organizer.id)).rows).toHaveLength(0);
  });
});

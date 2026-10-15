/**
 * Lipa Mdogo Mdogo policy and schedule maths. Pure functions (no I/O) except
 * the settings accessors at the bottom.
 *
 * Money is integer minor units (KES cents). M-Pesa only takes whole shillings,
 * so every amount in a schedule is a whole shilling: the deposit is rounded UP
 * (never below the required percentage) and the last installment absorbs the
 * remainder, so the parts always add up exactly to the booking total.
 */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { platformSettings, type User } from "@/db/schema";
import { audit } from "../audit";

export const planPolicySchema = z
  .object({
    enabled: z.boolean(),
    /** Deposit as basis points of the booking total (3000 = 30%). */
    depositBps: z.number().int().min(500).max(9000),
    /** Installment counts (after the deposit) a customer may choose from. */
    installmentOptions: z.array(z.number().int().min(1).max(6)).min(1).max(6),
    /** No new plans for events starting sooner than this. */
    minDaysBeforeEvent: z.number().int().min(2).max(180),
    /** The whole balance is due this many hours before the event starts. */
    finalDeadlineHours: z.number().int().min(24).max(24 * 30),
    /** Minimum spacing between consecutive installments. */
    minDaysBetweenPayments: z.number().min(0.5).max(60),
    /** How long an installment may be overdue before the plan ends (never past the final deadline). */
    overdueGraceHours: z.number().int().min(0).max(24 * 14),
    /** When an installment counts as "due" (and its reminder goes out). */
    reminderDaysBefore: z.number().int().min(1).max(14),
    /** Booking totals below this aren't offered a plan. */
    minBookingTotalKes: z.number().int().min(1).max(1_000_000),
    /** Smallest installment allowed (options producing smaller ones aren't offered). */
    minInstallmentKes: z.number().int().min(1).max(100_000),
    /** Retained on cancellation/expiry, basis points of the total (0 = everything refunded). */
    cancellationFeeBps: z.number().int().min(0).max(2000),
  })
  .refine((p) => p.finalDeadlineHours < p.minDaysBeforeEvent * 24, {
    message: "The final deadline must fall after the minimum booking window starts",
    path: ["finalDeadlineHours"],
  });
export type PlanPolicy = z.infer<typeof planPolicySchema>;

export const DEFAULT_PLAN_POLICY: PlanPolicy = {
  enabled: true,
  depositBps: 3000,
  installmentOptions: [1, 2, 3],
  minDaysBeforeEvent: 7,
  finalDeadlineHours: 48,
  minDaysBetweenPayments: 1,
  overdueGraceHours: 72,
  reminderDaysBefore: 3,
  minBookingTotalKes: 500,
  minInstallmentKes: 100,
  cancellationFeeBps: 0,
};

/** Bump when the customer-facing terms text changes; stored on each plan. */
export const PLAN_TERMS_VERSION = "2026-10-15";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type ScheduleLine = { sequence: number; amountMinor: number; dueAt: Date };
export type PlanQuote = {
  installmentCount: number;
  totalMinor: number;
  depositMinor: number;
  /** sequence 0 = deposit (due now), 1..n = installments. */
  lines: ScheduleLine[];
  finalDueAt: Date;
  cancellationFeeMinor: number;
};
export type Ineligible = { eligible: false; reason: string };

/** Splits `totalMinor` into a deposit + n whole-shilling installments. */
export function splitAmounts(totalMinor: number, depositBps: number, n: number) {
  if (!Number.isInteger(totalMinor) || totalMinor % 100 !== 0) throw new Error("Total must be whole shillings");
  const totalKes = totalMinor / 100;
  // Deposit rounds up so it is never below the required percentage.
  const depositKes = Math.min(totalKes, Math.ceil((totalKes * depositBps) / 10_000));
  const remainingKes = totalKes - depositKes;
  const baseKes = Math.floor(remainingKes / n);
  const parts = Array.from({ length: n }, (_, i) => (i === n - 1 ? remainingKes - baseKes * (n - 1) : baseKes));
  return { depositMinor: depositKes * 100, installmentsMinor: parts.map((k) => k * 100) };
}

/**
 * Whether a plan with `n` installments is possible for this booking now, and
 * its exact schedule. Installments are spread evenly between now and the final
 * deadline; the last one is due exactly at the deadline.
 */
export function quotePlan(args: { totalMinor: number; eventStartsAt: Date; policy: PlanPolicy; installmentCount: number; now?: Date }): PlanQuote | Ineligible {
  const { totalMinor, eventStartsAt, policy, installmentCount: n } = args;
  const now = args.now ?? new Date();
  if (!policy.enabled) return { eligible: false, reason: "Payment plans are currently unavailable." };
  if (!policy.installmentOptions.includes(n)) return { eligible: false, reason: "That plan option isn't offered." };
  if (totalMinor % 100 !== 0) return { eligible: false, reason: "Payment plans need a whole-shilling total." };
  if (totalMinor < policy.minBookingTotalKes * 100) return { eligible: false, reason: `Payment plans start from orders of KES ${policy.minBookingTotalKes.toLocaleString("en-KE")}.` };
  if (eventStartsAt.getTime() - now.getTime() < policy.minDaysBeforeEvent * DAY) {
    return { eligible: false, reason: `Payment plans are only available more than ${policy.minDaysBeforeEvent} days before the event.` };
  }
  const finalDueAt = new Date(eventStartsAt.getTime() - policy.finalDeadlineHours * HOUR);
  const span = finalDueAt.getTime() - now.getTime();
  if (span / n < policy.minDaysBetweenPayments * DAY) return { eligible: false, reason: "There isn't enough time before the event for that many installments." };
  const { depositMinor, installmentsMinor } = splitAmounts(totalMinor, policy.depositBps, n);
  if (installmentsMinor.some((a) => a < policy.minInstallmentKes * 100)) {
    return { eligible: false, reason: `Each installment must be at least KES ${policy.minInstallmentKes.toLocaleString("en-KE")}.` };
  }
  const lines: ScheduleLine[] = [
    { sequence: 0, amountMinor: depositMinor, dueAt: now },
    ...installmentsMinor.map((amountMinor, i) => ({
      sequence: i + 1,
      amountMinor,
      dueAt: i === n - 1 ? finalDueAt : new Date(now.getTime() + Math.round((span * (i + 1)) / n)),
    })),
  ];
  return {
    installmentCount: n,
    totalMinor,
    depositMinor,
    lines,
    finalDueAt,
    cancellationFeeMinor: Math.floor((totalMinor * policy.cancellationFeeBps) / 10_000 / 100) * 100,
  };
}

/** All plan options available for a booking (empty with a reason when none). */
export function planOptions(args: { totalMinor: number; eventStartsAt: Date; policy: PlanPolicy; now?: Date }): { options: PlanQuote[]; reason: string | null } {
  const options: PlanQuote[] = [];
  let reason: string | null = null;
  for (const n of [...args.policy.installmentOptions].sort((a, b) => a - b)) {
    const q = quotePlan({ ...args, installmentCount: n });
    if ("eligible" in q) reason ??= q.reason;
    else options.push(q);
  }
  return { options, reason: options.length ? null : reason ?? "Payment plans aren't available for this order." };
}

/** Refund owed when a plan ends early: everything paid minus the agreed fee (capped at what was paid). */
export function refundableOnEnd(paidMinor: number, cancellationFeeMinor: number, reason: string) {
  // Event cancellations and admin cancellations always refund in full.
  const fee = reason === "event_cancelled" || reason === "admin_cancelled" ? 0 : Math.min(paidMinor, cancellationFeeMinor);
  return { refundMinor: paidMinor - fee, retainedMinor: fee };
}

// ─── Settings ────────────────────────────────────────────────────────────────

const POLICY_KEY = "installment_policy";

export async function getPlanPolicy(tx: Tx = db): Promise<PlanPolicy> {
  const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.key, POLICY_KEY));
  const parsed = planPolicySchema.safeParse({ ...DEFAULT_PLAN_POLICY, ...((row?.value as object) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_PLAN_POLICY;
}

export async function setPlanPolicy(policy: PlanPolicy, actor: User) {
  const value = planPolicySchema.parse({ ...policy, installmentOptions: [...new Set(policy.installmentOptions)].sort((a, b) => a - b) });
  await db.transaction(async (tx) => {
    const before = await getPlanPolicy(tx);
    await tx
      .insert(platformSettings)
      .values({ key: POLICY_KEY, value, updatedBy: actor.id })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: actor.id, updatedAt: new Date() } });
    await audit(tx, { actorUserId: actor.id, action: "settings.installment_policy_updated", entityType: "platform_setting", entityId: POLICY_KEY, metadata: { before, after: value } });
  });
}

/** Plain-language terms shown before acceptance (and stored by version on the plan). */
export function planTerms(q: Pick<PlanQuote, "finalDueAt" | "cancellationFeeMinor">, policy: PlanPolicy, eventRefundPolicy: string) {
  const fee = q.cancellationFeeMinor;
  return [
    "No interest, no late fees and no credit check. This is a layaway plan, not a loan.",
    "Your tickets are reserved for you while you pay. Entry tickets with QR codes are issued only once the full balance has been paid.",
    `Pay installments in order. Each one is a separate M-Pesa request that you approve on your phone.`,
    `If an installment is more than ${policy.overdueGraceHours} hours overdue, or the balance isn't paid by the final deadline, the plan ends and the tickets are released.`,
    fee > 0
      ? `If the plan ends early or you cancel it, everything you've paid is refunded to your M-Pesa number except a KES ${(fee / 100).toLocaleString("en-KE")} cancellation fee.`
      : "If the plan ends early or you cancel it, everything you've paid is refunded to your M-Pesa number.",
    "If the event is cancelled, everything you've paid is refunded in full.",
    `After the plan is fully paid, the event's refund policy applies: ${eventRefundPolicy.slice(0, 300)}`,
  ];
}

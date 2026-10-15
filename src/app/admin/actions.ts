"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { eventReports, refunds, sessions, users } from "@/db/schema";
import { withFlash } from "@/components/dash/flash";
import { UserError, userMessage } from "@/lib/errors";
import { audit } from "@/server/audit";
import { requireAdmin } from "@/server/auth/guards";
import { refreshDeliveryStatus, removeSuppression, resendDelivery, retryConfigFailures, retryDelivery } from "@/server/email/admin";
import { resendConfig, senderDomainStatus } from "@/server/email/resend";
import { cancelEvent, refundBooking, revokeTicket } from "@/server/bookings/refunds";
import { retryJob } from "@/server/jobs/queue";
import { processDueJobs } from "@/server/jobs/queue";
import { setEventHidden, setOrganizerVerification } from "@/server/organizers/service";
import { checkMpesaPaymentStatus, resolveMpesaPayment } from "@/server/payments/mpesa";
import { completeRefund } from "@/server/payments/service";
import { MAX_COMMISSION_BPS, setCommissionBps, getCommissionBps } from "@/server/settings";
import { bannerLimitsSchema, setBannerLimits } from "@/server/banners/service";
import { planPolicySchema, setPlanPolicy } from "@/server/plans/policy";
import { adminCancelPlan, adminResolveLatePayment } from "@/server/plans/service";

const back = (fd: FormData, fallback: string) => {
  const b = String(fd.get("back") ?? "");
  return b.startsWith("/admin") ? b : fallback;
};

async function run(fd: FormData, fallback: string, fn: () => Promise<string>) {
  const to = back(fd, fallback);
  let msg: string;
  try {
    msg = await fn();
  } catch (err) {
    redirect(withFlash(to, "error", userMessage(err)));
  }
  revalidatePath("/", "layout");
  redirect(withFlash(to, "ok", msg));
}

export async function verifyOrganizerAction(fd: FormData) {
  const admin = await requireAdmin();
  const status = String(fd.get("status")) as "verified" | "rejected" | "suspended" | "pending";
  if (!["verified", "rejected", "suspended", "pending"].includes(status)) throw new Error("bad status");
  await run(fd, "/admin/organizers", async () => {
    await setOrganizerVerification(String(fd.get("organizerId")), status, admin, String(fd.get("note") ?? "").slice(0, 500));
    return `Organizer marked ${status}.`;
  });
}

export async function hideEventAction(fd: FormData) {
  const admin = await requireAdmin();
  const hidden = fd.get("hidden") === "true";
  await run(fd, "/admin/events", async () => {
    await setEventHidden(String(fd.get("eventId")), hidden, admin, String(fd.get("reason") ?? "").slice(0, 300));
    return hidden ? "Event hidden from the public." : "Event restored.";
  });
}

export async function adminCancelEventAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/events", async () => {
    const reason = String(fd.get("reason") ?? "").trim() || "Cancelled by Tikiti moderation";
    const r = await cancelEvent({ eventId: String(fd.get("eventId")), actorUserId: admin.id, reason });
    return `Event cancelled; ${r.refunded} booking(s) refunded.`;
  });
}

export async function resolveReportAction(fd: FormData) {
  const admin = await requireAdmin();
  const status = fd.get("status") === "dismissed" ? "dismissed" : "resolved";
  await run(fd, "/admin/events", async () => {
    await db.update(eventReports).set({ status, resolvedBy: admin.id, resolvedAt: new Date() }).where(eq(eventReports.id, String(fd.get("reportId"))));
    await audit(null, { actorUserId: admin.id, action: `report.${status}`, entityType: "event_report", entityId: String(fd.get("reportId")) });
    return `Report ${status}.`;
  });
}

export async function setCommissionAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/finance", async () => {
    const pct = Number(String(fd.get("percent") ?? "").trim());
    const bps = Math.round(pct * 100);
    if (!Number.isFinite(pct) || bps < 0 || bps > MAX_COMMISSION_BPS) throw new UserError(`Enter a rate between 0 and ${MAX_COMMISSION_BPS / 100}%.`);
    const previous = await getCommissionBps();
    await db.transaction(async (tx) => {
      await setCommissionBps(tx, bps, admin.id);
      await audit(tx, { actorUserId: admin.id, action: "settings.commission_changed", entityType: "settings", entityId: "commission_bps", metadata: { previous, next: bps } });
    });
    return `Commission set to ${(bps / 100).toFixed(2)}% for new bookings. Existing bookings keep their snapshotted rate.`;
  });
}

export async function adminRefundAction(fd: FormData) {
  const admin = await requireAdmin();
  const id = String(fd.get("bookingId"));
  await run(fd, `/admin/bookings/${id}`, async () => {
    await db.transaction((tx) =>
      refundBooking(tx, {
        bookingId: id,
        actorUserId: admin.id,
        reason: String(fd.get("reason") ?? "").slice(0, 300) || "Refunded by Tikiti support",
        returnInventory: fd.get("returnInventory") === "on",
      }),
    );
    return "Refund initiated.";
  });
}

export async function adminRevokeTicketAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/tickets", async () => {
    await revokeTicket({ ticketId: String(fd.get("ticketId")), actorUserId: admin.id, reason: String(fd.get("reason") ?? "") || "Revoked by Tikiti support" });
    return "Ticket revoked.";
  });
}

/** Retry a failed delivery in place (same Idempotency-Key, so never a duplicate). Never re-charges or re-issues tickets. */
export async function retryEmailAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    await retryDelivery(String(fd.get("deliveryId")), admin.id);
    await processDueJobs(5);
    return "Email re-queued.";
  });
}

/** Send a new copy (new delivery), optionally to a corrected address. */
export async function resendEmailAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    const to = String(fd.get("toEmail") ?? "").trim();
    await resendDelivery(String(fd.get("deliveryId")), admin.id, to || undefined);
    await processDueJobs(5);
    return to ? `Email queued to ${to}.` : "New copy queued.";
  });
}

export async function retryConfigFailuresAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    const n = await retryConfigFailures(admin.id);
    await processDueJobs(10);
    return `${n} email${n === 1 ? "" : "s"} re-queued.`;
  });
}

export async function refreshEmailStatusAction(fd: FormData) {
  await requireAdmin();
  await run(fd, "/admin/operations", async () => `Resend reports: ${await refreshDeliveryStatus(String(fd.get("deliveryId")))}.`);
}

export async function removeSuppressionAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    await removeSuppression(String(fd.get("suppressionId")), admin.id);
    return "Address can receive email again.";
  });
}

export async function checkSenderDomainAction(fd: FormData) {
  await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    const r = await senderDomainStatus(resendConfig());
    return `Sender domain ${r.domain}: ${r.status}.`;
  });
}

export async function retryJobAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    await retryJob(String(fd.get("jobId")));
    await audit(null, { actorUserId: admin.id, action: "job.retried", entityType: "job", entityId: String(fd.get("jobId")) });
    await processDueJobs(5);
    return "Job re-queued.";
  });
}

export async function runWorkerAction(fd: FormData) {
  await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    const r = await processDueJobs(25);
    return `Processed ${r.processed} job(s), ${r.failed} failed.`;
  });
}

export async function setUserStatusAction(fd: FormData) {
  const admin = await requireAdmin();
  const userId = String(fd.get("userId"));
  const status = fd.get("status") === "suspended" ? "suspended" : "active";
  await run(fd, "/admin/users", async () => {
    if (userId === admin.id) return "You can't change your own status.";
    await db.transaction(async (tx) => {
      await tx.update(users).set({ status, updatedAt: new Date() }).where(and(eq(users.id, userId)));
      if (status === "suspended") await tx.delete(sessions).where(eq(sessions.userId, userId));
      await audit(tx, { actorUserId: admin.id, action: `user.${status}`, entityType: "user", entityId: userId });
    });
    return `User ${status}.`;
  });
}


// ─── M-Pesa reconciliation ───────────────────────────────────────────────────

export async function mpesaCheckStatusAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    const paymentId = String(fd.get("paymentId"));
    const outcome = await checkMpesaPaymentStatus(paymentId, { manual: true });
    await audit(null, { actorUserId: admin.id, action: "payment.status_checked", entityType: "payment", entityId: paymentId, metadata: { outcome } });
    await processDueJobs(5);
    return `M-Pesa status check: ${outcome.replace(/_/g, " ")}.`;
  });
}

export async function mpesaResolveAction(fd: FormData) {
  const admin = await requireAdmin();
  const resolution = String(fd.get("resolution"));
  if (resolution !== "paid" && resolution !== "not_paid") throw new Error("bad resolution");
  await run(fd, "/admin/operations", async () => {
    const outcome = await resolveMpesaPayment({
      paymentId: String(fd.get("paymentId")),
      resolution,
      receipt: String(fd.get("receipt") ?? ""),
      actorUserId: admin.id,
    });
    await processDueJobs(5);
    return `Payment resolved: ${outcome.replace(/_/g, " ")}.`;
  });
}

export async function recordManualRefundAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/operations", async () => {
    const reference = String(fd.get("reversalReference") ?? "").trim().toUpperCase();
    if (!/^[A-Z0-9]{8,20}$/.test(reference)) throw new UserError("Enter the M-Pesa reversal transaction ID.");
    const [refund] = await db.select().from(refunds).where(eq(refunds.id, String(fd.get("refundId"))));
    if (!refund || refund.status !== "manual_required" || !refund.paymentTransactionId) throw new UserError("This refund isn't awaiting a manual reversal.");
    await completeRefund(refund.id, refund.paymentTransactionId, reference, admin.id);
    return "Refund recorded as completed.";
  });
}

export async function setBannerLimitsAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/ai-banners", async () => {
    const num = (k: string) => Number(fd.get(k));
    const parsed = bannerLimitsSchema.safeParse({
      enabled: fd.get("enabled") === "on",
      imagesPerOrganizerPerDay: num("imagesPerOrganizerPerDay"),
      imagesPerOrganizerPerMonth: num("imagesPerOrganizerPerMonth"),
      imagesPlatformPerMonth: num("imagesPlatformPerMonth"),
      maxImagesPerRequest: num("maxImagesPerRequest"),
      requestsPerUserPerMinute: num("requestsPerUserPerMinute"),
    });
    if (!parsed.success) throw new UserError(`Invalid limits: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    await setBannerLimits(parsed.data, admin);
    return "AI banner limits saved.";
  });
}

export async function setPlanPolicyAction(fd: FormData) {
  const admin = await requireAdmin();
  await run(fd, "/admin/payment-plans", async () => {
    const num = (k: string) => Number(fd.get(k));
    const parsed = planPolicySchema.safeParse({
      enabled: fd.get("enabled") === "on",
      depositBps: Math.round(num("depositPercent") * 100),
      installmentOptions: fd.getAll("installmentOptions").map(Number),
      minDaysBeforeEvent: num("minDaysBeforeEvent"),
      finalDeadlineHours: num("finalDeadlineHours"),
      minDaysBetweenPayments: num("minDaysBetweenPayments"),
      overdueGraceHours: num("overdueGraceHours"),
      reminderDaysBefore: num("reminderDaysBefore"),
      minBookingTotalKes: num("minBookingTotalKes"),
      minInstallmentKes: num("minInstallmentKes"),
      cancellationFeeBps: Math.round(num("cancellationFeePercent") * 100),
    });
    if (!parsed.success) throw new UserError(`Invalid policy: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    await setPlanPolicy(parsed.data, admin);
    return "Installment policy saved. It applies to new plans only — existing plans keep the terms customers accepted.";
  });
}

export async function adminCancelPlanAction(fd: FormData) {
  const admin = await requireAdmin();
  const id = String(fd.get("planId") ?? "");
  await run(fd, `/admin/payment-plans/${id}`, async () => {
    const reason = String(fd.get("reason") ?? "").trim();
    if (reason.length < 5) throw new UserError("Give a short reason (it's recorded in the audit log).");
    const r = await adminCancelPlan(id, admin, reason);
    await processDueJobs(5);
    return r.refundMinor > 0 ? `Plan cancelled; refund of KES ${(r.refundMinor / 100).toLocaleString("en-KE")} started.` : "Plan cancelled.";
  });
}

export async function resolveLatePlanPaymentAction(fd: FormData) {
  const admin = await requireAdmin();
  const id = String(fd.get("planId") ?? "");
  await run(fd, `/admin/payment-plans/${id}`, async () => {
    const action = fd.get("resolution") === "reinstate" ? "reinstate" : "refund";
    const msg = await adminResolveLatePayment(id, admin, action);
    await processDueJobs(5);
    return msg;
  });
}

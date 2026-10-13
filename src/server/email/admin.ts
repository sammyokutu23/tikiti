/**
 * Operator tools for email delivery. Nothing here re-charges a customer or
 * re-issues tickets: retries re-render the same booking/ticket records.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, emailDeliveries, emailProviderEvents, emailSuppressions } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { audit } from "../audit";
import { enqueueJob } from "../jobs/queue";
import { applyPolledStatus } from "./events";
import { emailIdempotencyKey } from "./queue";
import { fetchResendEmailStatus, isEmailAddress, resendConfig } from "./resend";

/** Statuses an operator can retry in place (same delivery, same Idempotency-Key). */
const RETRYABLE_IN_PLACE = new Set(["failed", "retry_pending", "queued"]);
/** Retrying these in place can't help: the key is burned or the outcome is unknown. */
const NEEDS_NEW_DELIVERY = new Set(["idempotency_conflict"]);

export function canRetryInPlace(d: { kind: string; status: string; lastErrorCategory: string | null; firstAttemptAt: Date | null }) {
  if (!RETRYABLE_IN_PLACE.has(d.status) || d.kind === "account_email") return false;
  if (d.lastErrorCategory && NEEDS_NEW_DELIVERY.has(d.lastErrorCategory)) return false;
  // Past Resend's 24h idempotency window an uncertain attempt can't be retried safely in place.
  if ((d.lastErrorCategory === "uncertain" || d.lastErrorCategory === "provider_unavailable") && d.firstAttemptAt && Date.now() - d.firstAttemptAt.getTime() > 23 * 3600_000) return false;
  return true;
}

/** Same delivery again: Resend dedupes on the delivery's Idempotency-Key, so this can't double-send. */
export async function retryDelivery(deliveryId: string, actorUserId: string) {
  return db.transaction(async (tx) => {
    const [d] = await tx.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId)).for("update");
    if (!d) throw new UserError("Delivery not found.");
    if (!canRetryInPlace(d)) throw new UserError("This email can't be retried in place — use “Send again” to create a new email.");
    if (d.lastErrorCategory === "invalid_recipient") throw new UserError("This email has no valid recipient. Use “Send to another address”.");
    await tx.update(emailDeliveries).set({ status: "queued", updatedAt: new Date() }).where(eq(emailDeliveries.id, d.id));
    await enqueueJob(tx, "email.send", { deliveryId: d.id }, { dedupeKey: `email:${d.id}:${Date.now()}`, maxAttempts: 3 });
    await audit(tx, { actorUserId, action: "email.retried", entityType: "email_delivery", entityId: d.id, metadata: { idempotencyKey: emailIdempotencyKey(d.id) } });
    return d.id;
  });
}

/**
 * A brand-new email (new delivery id → new Idempotency-Key) with the same content,
 * optionally to a corrected address. For a booking email, a corrected address also
 * becomes the booking's contact email. Account emails can't be resent (one-time codes).
 */
export async function resendDelivery(deliveryId: string, actorUserId: string, toEmail?: string) {
  const [d] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId));
  if (!d) throw new UserError("Delivery not found.");
  if (d.kind === "account_email") throw new UserError("Account emails contain one-time codes and can't be resent. Ask the user to request a new code.");
  const target = (toEmail ?? d.toEmail).trim();
  if (!isEmailAddress(target)) throw new UserError("Enter a valid email address.");
  return db.transaction(async (tx) => {
    if (toEmail && d.bookingId && target.toLowerCase() !== d.toEmail.toLowerCase()) {
      const [b] = await tx.select().from(bookings).where(eq(bookings.id, d.bookingId)).for("update");
      if (b && b.buyerEmail.toLowerCase() === d.toEmail.toLowerCase()) {
        await tx.update(bookings).set({ buyerEmail: target, updatedAt: new Date() }).where(eq(bookings.id, b.id));
        await audit(tx, { actorUserId, action: "booking.contact_email_changed", entityType: "booking", entityId: b.id, metadata: { reference: b.reference, deliveryId: d.id } });
      }
    }
    const [n] = await tx
      .insert(emailDeliveries)
      .values({ kind: d.kind, bookingId: d.bookingId, userId: d.userId, eventId: d.eventId, toEmail: target, subject: d.subject, metadata: d.metadata })
      .returning();
    await enqueueJob(tx, "email.send", { deliveryId: n.id }, { dedupeKey: `email:${n.id}:0`, maxAttempts: 5 });
    await audit(tx, { actorUserId, action: "email.resent", entityType: "email_delivery", entityId: d.id, metadata: { newDeliveryId: n.id, changedRecipient: target !== d.toEmail } });
    return n.id;
  });
}

/** After fixing configuration (API key, sender domain): re-queue every delivery that failed on it. */
export async function retryConfigFailures(actorUserId: string) {
  const rows = await db
    .select()
    .from(emailDeliveries)
    .where(sql`${emailDeliveries.status} = 'failed' and ${emailDeliveries.lastErrorCategory} = 'config'`)
    .limit(500);
  for (const d of rows) await retryDelivery(d.id, actorUserId);
  return rows.length;
}

/** Asks Resend for the message's latest state (when a webhook was missed or isn't configured). */
export async function refreshDeliveryStatus(deliveryId: string) {
  const [d] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId));
  if (!d?.providerMessageId || d.transport !== "resend") throw new UserError("Only emails accepted by Resend can be refreshed.");
  const last = await fetchResendEmailStatus(resendConfig(), d.providerMessageId);
  if (last) await applyPolledStatus(d.id, last);
  return last ?? "unknown";
}

export async function removeSuppression(id: string, actorUserId: string) {
  await db.transaction(async (tx) => {
    const [s] = await tx.delete(emailSuppressions).where(eq(emailSuppressions.id, id)).returning();
    if (!s) throw new UserError("Suppression not found.");
    await audit(tx, { actorUserId, action: "email.suppression_removed", entityType: "email_suppression", entityId: id, metadata: { reason: s.reason } });
  });
}

export async function emailOperationsView() {
  const [deliveries, problems, suppressions, unmatched] = await Promise.all([
    db
      .select({ e: emailDeliveries, ref: bookings.reference })
      .from(emailDeliveries)
      .leftJoin(bookings, eq(bookings.id, emailDeliveries.bookingId))
      .orderBy(desc(emailDeliveries.createdAt))
      .limit(50),
    db
      .select({ e: emailDeliveries, ref: bookings.reference })
      .from(emailDeliveries)
      .leftJoin(bookings, eq(bookings.id, emailDeliveries.bookingId))
      .where(inArray(emailDeliveries.status, ["failed", "bounced", "complained", "suppressed", "retry_pending"]))
      .orderBy(desc(emailDeliveries.updatedAt))
      .limit(50),
    db.select().from(emailSuppressions).orderBy(desc(emailSuppressions.createdAt)).limit(50),
    db.$count(emailProviderEvents, sql`${emailProviderEvents.outcome} = 'unmatched'`),
  ]);
  return { deliveries, problems, suppressions, unmatched };
}

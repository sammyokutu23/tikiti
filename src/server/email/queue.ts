import { db, type Tx } from "@/db";
import { emailDeliveries } from "@/db/schema";
import { isUniqueViolation } from "@/lib/errors";
import { enqueueJob } from "../jobs/queue";
import { isEmailAddress } from "./resend";

export type EmailKind =
  // customer — bookings & payments
  | "booking_confirmation"
  | "booking_access_link"
  | "booking_refunded"
  | "event_cancelled"
  | "refund_completed"
  | "payment_failed"
  | "payment_review"
  // customer — Lipa Mdogo Mdogo payment plans
  | "plan_deposit_confirmed"
  | "plan_payment_confirmed"
  | "plan_payment_failed"
  | "plan_installment_due"
  | "plan_installment_overdue"
  | "plan_final_deadline"
  | "plan_ended"
  | "plan_payment_review"
  // customer — resale marketplace
  | "resale_purchase_confirmed"
  | "resale_sold"
  | "resale_listing_reviewed"
  // customer — event lifecycle
  | "event_reminder"
  | "event_updated"
  // organizer
  | "organizer_event_published"
  | "organizer_event_attention"
  | "organizer_new_sale"
  | "organizer_event_cancelled"
  // account (rendered by Clerk, delivered by us when Clerk delivery is turned off)
  | "account_email";

/**
 * Service messages the recipient needs regardless of complaints: tickets, refunds,
 * changes to an event they paid for, and sign-in codes. A hard bounce still blocks
 * them (the address doesn't work); a spam complaint only blocks the others.
 * TikoSoko sends no marketing email, so there is no marketing consent to check.
 */
export const CRITICAL_KINDS: ReadonlySet<EmailKind> = new Set([
  "booking_confirmation",
  "booking_access_link",
  "booking_refunded",
  "event_cancelled",
  "refund_completed",
  "event_updated",
  "account_email",
  "plan_deposit_confirmed",
  "plan_payment_confirmed",
  "plan_ended",
  "resale_purchase_confirmed",
  "resale_sold",
]);

const SUBJECT_PLACEHOLDER: Record<EmailKind, string> = {
  booking_confirmation: "Your tickets",
  booking_access_link: "Your booking link",
  booking_refunded: "Your booking was refunded",
  event_cancelled: "Event cancelled",
  refund_completed: "Refund completed",
  payment_failed: "Payment not completed",
  payment_review: "Confirming your payment",
  plan_deposit_confirmed: "Payment plan active",
  plan_payment_confirmed: "Installment received",
  plan_payment_failed: "Installment not completed",
  plan_installment_due: "Installment due soon",
  plan_installment_overdue: "Installment overdue",
  plan_final_deadline: "Final payment deadline",
  plan_ended: "Payment plan ended",
  plan_payment_review: "Confirming your installment",
  resale_purchase_confirmed: "Your resale ticket",
  resale_sold: "Your ticket sold",
  resale_listing_reviewed: "Your resale listing",
  event_reminder: "Event reminder",
  event_updated: "Event update",
  organizer_event_published: "Event published",
  organizer_event_attention: "Event needs attention",
  organizer_new_sale: "New booking",
  organizer_event_cancelled: "Event cancelled",
  account_email: "Account email",
};

export const emailIdempotencyKey = (deliveryId: string) => `tikosoko-email-${deliveryId}`;

/**
 * Records an email delivery and queues the send job in the caller's transaction,
 * so an email exists if and only if the state change that needs it committed.
 * `dedupeKey` makes automatic emails idempotent (e.g. one confirmation per booking,
 * however many duplicate payment callbacks arrive).
 * Returns the delivery id, or null if a delivery with the same dedupe key exists.
 * A missing/invalid recipient is recorded as failed (visible to admins), never sent.
 */
export async function queueEmail(
  tx: Tx,
  args: {
    kind: EmailKind;
    toEmail: string | null | undefined;
    bookingId?: string;
    userId?: string;
    eventId?: string;
    dedupeKey?: string;
    /** Small non-sensitive template inputs. */
    metadata?: Record<string, unknown>;
    /** Secret, short-lived data needed to render (e.g. a sign-in code). Dropped after the job ends. */
    secret?: string;
    maxAttempts?: number;
  },
): Promise<string | null> {
  const recipient = args.toEmail?.trim() ?? "";
  const valid = isEmailAddress(recipient);
  let rows: { id: string }[];
  try {
    rows = await tx
      .insert(emailDeliveries)
      .values({
        kind: args.kind,
        toEmail: recipient,
        bookingId: args.bookingId ?? null,
        userId: args.userId ?? null,
        eventId: args.eventId ?? null,
        subject: SUBJECT_PLACEHOLDER[args.kind],
        dedupeKey: args.dedupeKey ?? null,
        metadata: args.metadata ?? {},
        ...(valid ? {} : { status: "failed" as const, lastErrorCategory: "invalid_recipient", lastError: recipient ? "Recipient address is not valid" : "No recipient email address" }),
      })
      .onConflictDoNothing({ target: emailDeliveries.dedupeKey })
      .returning({ id: emailDeliveries.id });
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  if (!rows[0]) return null;
  if (valid) {
    await enqueueJob(
      tx,
      "email.send",
      { deliveryId: rows[0].id, ...(args.secret ? { secret: args.secret } : {}) },
      { dedupeKey: `email:${rows[0].id}:0`, maxAttempts: args.maxAttempts ?? 6 },
    );
  }
  return rows[0].id;
}

/** Manual resend of booking tickets — creates a new delivery record each time. */
export async function queueTicketResend(bookingId: string, toEmail: string) {
  return db.transaction((tx) =>
    queueEmail(tx, { kind: "booking_confirmation", bookingId, toEmail, dedupeKey: undefined }),
  );
}

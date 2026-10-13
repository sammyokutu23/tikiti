/**
 * Job handler for "email.send": renders one delivery and hands it to the
 * configured transport (Resend in production).
 *
 * Safe to retry:
 *  - A delivery that already reached the provider is never sent again by the job.
 *  - Every provider request carries the same Idempotency-Key (the delivery id), and
 *    rendering is deterministic (fixed PDF dates, link tokens anchored to the
 *    delivery), so a retry after a timeout is deduplicated by Resend.
 *  - Ticket PDFs are rendered here from the stored ticket records — never at
 *    payment time — so a PDF or provider failure only fails this job; the paid,
 *    confirmed booking is untouched and the job retries with backoff.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  bookingItems,
  bookings,
  emailDeliveries,
  emailSuppressions,
  events,
  organizerProfiles,
  paymentTransactions,
  type EmailDelivery,
} from "@/db/schema";
import { env } from "@/lib/env";
import { directionsUrl, eventCoordinates } from "@/lib/location";
import { createBookingAccessToken } from "../bookings/access";
import { JobError } from "../jobs/queue";
import { renderBookingPdf } from "../tickets/documents";
import { applyStoredProviderEvents } from "./events";
import { CRITICAL_KINDS, emailIdempotencyKey, type EmailKind } from "./queue";
import { EmailConfigError, EmailSendError, isEmailAddress, type EmailErrorCategory } from "./resend";
import {
  bookingAccessEmail,
  bookingConfirmationEmail,
  bookingRefundedEmail,
  eventReminderEmail,
  eventUpdatedEmail,
  organizerEventAttentionEmail,
  organizerEventCancelledEmail,
  organizerEventPublishedEmail,
  organizerNewSaleEmail,
  paymentFailedEmail,
  paymentReviewEmail,
  refundCompletedEmail,
  type BookingEmailData,
  type OrganizerEmailData,
} from "./templates";
import { getEmailTransport, type OutgoingEmail } from "./transport";

/** Resend keeps idempotency keys for 24h; past that a retry could duplicate an uncertain send. */
const IDEMPOTENCY_WINDOW_MS = 23 * 3600_000;

export function maxAttachmentBytes() {
  const v = Number(process.env.EMAIL_MAX_ATTACHMENT_BYTES ?? 10 * 1024 * 1024);
  return Number.isFinite(v) && v > 0 ? v : 10 * 1024 * 1024;
}

export function isValidPdf(bytes: Uint8Array) {
  if (bytes.length < 64) return false;
  const head = Buffer.from(bytes.subarray(0, 5)).toString("latin1");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString("latin1");
  return head === "%PDF-" && tail.includes("%%EOF");
}

export const safeFilename = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "tickets.pdf";

// ─── Template data (always loaded from the database) ─────────────────────────

async function bookingContext(bookingId: string, linkIssuedAt: Date) {
  const [row] = await db
    .select({ b: bookings, e: events })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(eq(bookings.id, bookingId));
  if (!row) throw new EmailSendError("Booking not found", "render", { retryable: false });
  const items = await db.select().from(bookingItems).where(eq(bookingItems.bookingId, bookingId));
  // Anchored to the delivery's creation so a retry renders the identical link.
  const token = createBookingAccessToken(row.b.id, row.e.endsAt, linkIssuedAt);
  const data: BookingEmailData = {
    buyerName: row.b.buyerName,
    reference: row.b.reference,
    eventTitle: row.e.title,
    startsAt: row.e.startsAt,
    timezone: row.e.timezone,
    venue: [row.e.venueName, row.e.venueAddress, row.e.city].filter(Boolean).join(", "),
    directionsUrl: (() => {
      const c = eventCoordinates(row.e);
      return c ? directionsUrl(c) : null;
    })(),
    arrivalInstructions: row.e.arrivalInstructions || undefined,
    items: items.map((i) => ({ name: i.ticketTypeName, quantity: i.quantity, lineTotalMinor: i.lineTotalMinor })),
    totalMinor: row.b.totalMinor,
    currency: row.b.currency,
    ticketCount: items.reduce((s, i) => s + i.quantity, 0),
    ticketsUrl: `${env.appUrl}/bookings/${row.b.reference}?access=${token}`,
    eventUrl: `${env.appUrl}/events/${row.e.slug}`,
    supportEmail: env.supportEmail,
    reason: row.e.cancellationReason ?? undefined,
  };
  return { booking: row.b, event: row.e, token, data };
}

async function organizerContext(eventId: string): Promise<OrganizerEmailData> {
  const [row] = await db
    .select({ e: events, o: organizerProfiles })
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(events.id, eventId));
  if (!row) throw new EmailSendError("Event not found", "render", { retryable: false });
  return {
    organizerName: row.o.displayName,
    eventTitle: row.e.title,
    startsAt: row.e.startsAt,
    timezone: row.e.timezone,
    eventUrl: `${env.appUrl}/events/${row.e.slug}`,
    dashboardUrl: `${env.appUrl}/organizer/events/${row.e.id}`,
    supportEmail: env.supportEmail,
  };
}

type Rendered = { msg: Omit<OutgoingEmail, "to"> } | { skip: string };

async function render(d: EmailDelivery, secret: string | undefined): Promise<Rendered> {
  const meta = (d.metadata ?? {}) as Record<string, unknown>;
  const kind = d.kind as EmailKind;
  switch (kind) {
    case "booking_confirmation": {
      const { booking, data } = await bookingContext(d.bookingId!, d.createdAt);
      if (booking.status !== "confirmed") return { skip: `booking is ${booking.status}` };
      let pdf: Awaited<ReturnType<typeof renderBookingPdf>>;
      try {
        pdf = await renderBookingPdf(booking.id, { createdAt: booking.confirmedAt ?? booking.createdAt });
      } catch (err) {
        throw new EmailSendError(`PDF generation failed: ${(err as Error).message}`.slice(0, 500), "render", { retryable: true });
      }
      if (pdf.count !== data.ticketCount) {
        throw new EmailSendError(`PDF has ${pdf.count} tickets but the booking has ${data.ticketCount}`, "render", { retryable: true });
      }
      if (!isValidPdf(pdf.bytes)) throw new EmailSendError("Generated ticket file is not a valid PDF", "render", { retryable: true });
      const attach = pdf.bytes.length <= maxAttachmentBytes();
      const tickets = pdf.tickets.map((t) => ({ ticketType: t.ticketType, label: t.label, attendeeName: t.attendeeName || data.buyerName }));
      const c = bookingConfirmationEmail({ ...data, tickets, attachmentOmitted: !attach });
      return {
        msg: {
          ...c,
          attachments: attach ? [{ filename: safeFilename(pdf.filename), content: Buffer.from(pdf.bytes), contentType: "application/pdf" }] : [],
        },
      };
    }
    case "booking_access_link":
      return { msg: bookingAccessEmail((await bookingContext(d.bookingId!, d.createdAt)).data) };
    case "booking_refunded":
    case "event_cancelled":
      return { msg: bookingRefundedEmail((await bookingContext(d.bookingId!, d.createdAt)).data, kind === "event_cancelled") };
    case "refund_completed": {
      const { data } = await bookingContext(d.bookingId!, d.createdAt);
      return { msg: refundCompletedEmail({ ...data, amountMinor: Number(meta.amountMinor ?? data.totalMinor), method: String(meta.method ?? "") }) };
    }
    case "payment_failed": {
      const { booking, event, token, data } = await bookingContext(d.bookingId!, d.createdAt);
      if (booking.status === "confirmed" || booking.status === "refunded") return { skip: `booking is ${booking.status}` };
      const holdOpen = booking.status === "pending" && booking.expiresAt > new Date() && event.status === "published";
      const retryUrl = holdOpen ? `${env.appUrl}/checkout/${booking.reference}?access=${token}` : data.eventUrl!;
      return { msg: paymentFailedEmail({ ...data, reason: String(meta.reason ?? "the payment was not completed"), retryUrl, holdOpen }) };
    }
    case "payment_review": {
      const { booking, data } = await bookingContext(d.bookingId!, d.createdAt);
      if (booking.status === "confirmed") return { skip: "booking already confirmed" };
      if (meta.paymentId) {
        const [p] = await db.select({ status: paymentTransactions.status }).from(paymentTransactions).where(eq(paymentTransactions.id, String(meta.paymentId)));
        if (p && p.status !== "reconciliation_required") return { skip: `payment is ${p.status}` };
      }
      return { msg: paymentReviewEmail(data) };
    }
    case "event_reminder": {
      const { booking, event, data } = await bookingContext(d.bookingId!, d.createdAt);
      if (booking.status !== "confirmed" || event.status !== "published" || event.startsAt <= new Date()) return { skip: "event no longer upcoming for this booking" };
      return { msg: eventReminderEmail(data) };
    }
    case "event_updated": {
      const { booking, data } = await bookingContext(d.bookingId!, d.createdAt);
      if (booking.status !== "confirmed") return { skip: `booking is ${booking.status}` };
      const changes = Array.isArray(meta.changes) ? meta.changes.map(String).slice(0, 6) : ["Event details were updated"];
      return { msg: eventUpdatedEmail({ ...data, changes }) };
    }
    case "organizer_event_published":
      return { msg: organizerEventPublishedEmail(await organizerContext(d.eventId!)) };
    case "organizer_event_attention":
      return { msg: organizerEventAttentionEmail({ ...(await organizerContext(d.eventId!)), reason: String(meta.reason ?? "Please contact support") }) };
    case "organizer_event_cancelled":
      return {
        msg: organizerEventCancelledEmail({ ...(await organizerContext(d.eventId!)), reason: String(meta.reason ?? ""), bookingCount: Number(meta.bookingCount ?? 0) }),
      };
    case "organizer_new_sale": {
      const { booking, data } = await bookingContext(d.bookingId!, d.createdAt);
      return {
        msg: organizerNewSaleEmail({ ...(await organizerContext(booking.eventId)), reference: booking.reference, ticketCount: data.ticketCount, totalMinor: booking.totalMinor, currency: booking.currency }),
      };
    }
    case "account_email": {
      // Rendered by Clerk (verified webhook); the content lives only in the job's secret.
      if (!secret) throw new EmailSendError("Account email content is no longer available", "render", { retryable: false });
      const c = JSON.parse(secret) as { subject: string; html: string; text: string };
      return { msg: { subject: c.subject.slice(0, 200), html: c.html, text: c.text || c.subject } };
    }
    default:
      throw new EmailSendError(`Unknown email kind ${d.kind}`, "render", { retryable: false });
  }
}

function categorize(err: unknown): { category: EmailErrorCategory | "unknown"; retryable: boolean; uncertain: boolean; retryAfterMs: number | null } {
  if (err instanceof EmailSendError) return { category: err.category, retryable: err.retryable, uncertain: err.uncertain, retryAfterMs: err.retryAfterMs };
  if (err instanceof EmailConfigError) return { category: "config", retryable: false, uncertain: false, retryAfterMs: null };
  // SMTP / unexpected errors: transient until proven otherwise (bounded by max attempts).
  return { category: "unknown", retryable: true, uncertain: false, retryAfterMs: null };
}

async function finish(id: string, set: Partial<EmailDelivery>) {
  await db.update(emailDeliveries).set({ ...set, updatedAt: new Date() }).where(eq(emailDeliveries.id, id));
}

export async function sendQueuedEmail(payload: { deliveryId: string; secret?: string }, attempt: { isLast: boolean }) {
  // Claim: only a delivery that hasn't reached the provider can move to "sending".
  const [d] = await db
    .update(emailDeliveries)
    .set({
      status: "sending",
      attempts: sql`${emailDeliveries.attempts} + 1`,
      firstAttemptAt: sql`coalesce(${emailDeliveries.firstAttemptAt}, now())`,
      updatedAt: new Date(),
    })
    .where(and(eq(emailDeliveries.id, payload.deliveryId), sql`${emailDeliveries.status} in ('queued', 'retry_pending', 'sending')`))
    .returning();
  if (!d) return; // already sent, final, or unknown — nothing to do

  if (!isEmailAddress(d.toEmail)) {
    await finish(d.id, { status: "failed", lastErrorCategory: "invalid_recipient", lastError: "No valid recipient email address" });
    return;
  }

  const [suppression] = await db
    .select()
    .from(emailSuppressions)
    .where(sql`lower(${emailSuppressions.email}) = lower(${d.toEmail})`);
  if (suppression && (suppression.reason !== "complaint" || !CRITICAL_KINDS.has(d.kind as EmailKind))) {
    await finish(d.id, { status: "suppressed", lastErrorCategory: "suppressed", lastError: `Address is on the suppression list (${suppression.reason})` });
    return;
  }

  // An uncertain attempt older than Resend's idempotency window can't be retried blindly.
  if (
    (d.lastErrorCategory === "uncertain" || d.lastErrorCategory === "provider_unavailable") &&
    d.firstAttemptAt &&
    Date.now() - d.firstAttemptAt.getTime() > IDEMPOTENCY_WINDOW_MS
  ) {
    await finish(d.id, {
      status: "failed",
      lastErrorCategory: "uncertain",
      lastError: "An earlier attempt may have been sent and the duplicate-protection window has passed. Check the Resend dashboard, then resend manually if needed.",
    });
    return;
  }

  let msg: OutgoingEmail | null = null;
  try {
    const r = await render(d, payload.secret);
    if ("skip" in r) {
      await finish(d.id, { status: "skipped", lastError: `Not sent: ${r.skip}`, lastErrorCategory: null });
      return;
    }
    msg = {
      to: d.toEmail,
      ...r.msg,
      idempotencyKey: emailIdempotencyKey(d.id),
      tags: { kind: d.kind, delivery_id: d.id },
    };
    const transport = getEmailTransport();
    const result = await transport.send(msg);
    await finish(d.id, {
      status: result.status,
      transport: result.transport,
      providerMessageId: result.messageId,
      // Account emails' subjects can contain one-time codes: keep the placeholder.
      subject: d.kind === "account_email" ? d.subject : msg.subject,
      attachmentCount: msg.attachments?.length ?? 0,
      metadata: msg.attachments?.length === 0 && d.kind === "booking_confirmation" ? { ...(d.metadata as object), attachmentOmitted: true } : d.metadata,
      lastError: null,
      lastErrorCategory: null,
      sentAt: new Date(),
    });
    if (result.transport === "resend") await applyStoredProviderEvents(d.id, result.messageId);
  } catch (err) {
    const c = categorize(err);
    const final = !c.retryable || attempt.isLast;
    await finish(d.id, {
      status: final ? "failed" : "retry_pending",
      lastErrorCategory: c.category,
      lastError: (err as Error).message.slice(0, 1000),
      transport: transportName(),
      ...(msg && d.kind !== "account_email" ? { subject: msg.subject } : {}),
    });
    throw new JobError((err as Error).message, c.retryable, c.retryAfterMs);
  }
}

function transportName() {
  try {
    return getEmailTransport().name;
  } catch {
    return env.emailTransport;
  }
}

/**
 * Domain triggers for transactional email. Each helper only records a delivery
 * (and its outbox job) inside the caller's transaction; rendering and sending
 * happen later in the worker. Dedupe keys make every automatic email idempotent.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { bookings, emailDeliveries, events, organizerProfiles, paymentTransactions, type Event } from "@/db/schema";
import { formatDateTime } from "@/lib/dates";
import { enqueueJob } from "../jobs/queue";
import { queueEmail, type EmailKind } from "./queue";

// ─── Organizer ───────────────────────────────────────────────────────────────

export async function queueOrganizerEmail(
  tx: Tx,
  eventId: string,
  kind: Extract<EmailKind, `organizer_${string}`>,
  opts: { dedupeKey?: string; metadata?: Record<string, unknown>; bookingId?: string } = {},
) {
  const [row] = await tx
    .select({ email: organizerProfiles.contactEmail })
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(events.id, eventId));
  if (!row) return null;
  return queueEmail(tx, { kind, toEmail: row.email, eventId, bookingId: opts.bookingId, dedupeKey: opts.dedupeKey, metadata: opts.metadata });
}

// ─── Payments ────────────────────────────────────────────────────────────────

/** "We're confirming your payment — don't pay again." Once per payment attempt. */
export async function queuePaymentReviewEmail(tx: Tx, paymentId: string) {
  const [row] = await tx
    .select({ bookingId: bookings.id, email: bookings.buyerEmail, status: bookings.status, eventId: bookings.eventId })
    .from(paymentTransactions)
    .innerJoin(bookings, eq(bookings.id, paymentTransactions.bookingId))
    .where(eq(paymentTransactions.id, paymentId));
  if (!row || row.status === "confirmed") return null;
  return queueEmail(tx, {
    kind: "payment_review",
    toEmail: row.email,
    bookingId: row.bookingId,
    eventId: row.eventId,
    dedupeKey: `payment_review:${paymentId}`,
    metadata: { paymentId },
  });
}

/** Asynchronous M-Pesa failure (callback / status query / admin): the buyer may have left the page. */
export async function queuePaymentFailedEmail(tx: Tx, args: { paymentId: string; bookingId: string; eventId: string; toEmail: string; reason: string }) {
  return queueEmail(tx, {
    kind: "payment_failed",
    toEmail: args.toEmail,
    bookingId: args.bookingId,
    eventId: args.eventId,
    dedupeKey: `payment_failed:${args.paymentId}`,
    metadata: { paymentId: args.paymentId, reason: args.reason.slice(0, 200) },
  });
}

// ─── Event changes ───────────────────────────────────────────────────────────

/** Human-readable list of changes ticket holders must know about (time, venue, pin). */
export function significantEventChanges(before: Event, after: Event): string[] {
  const out: string[] = [];
  if (before.startsAt.getTime() !== after.startsAt.getTime() || before.timezone !== after.timezone) {
    out.push(`New date & time: ${formatDateTime(after.startsAt, after.timezone)} (was ${formatDateTime(before.startsAt, before.timezone)})`);
  } else if (before.endsAt.getTime() !== after.endsAt.getTime()) {
    out.push(`New end time: ${formatDateTime(after.endsAt, after.timezone)}`);
  }
  const venue = (e: Event) => [e.venueName, e.venueAddress, e.city].filter(Boolean).join(", ");
  if (venue(before) !== venue(after)) out.push(`New venue: ${venue(after)}`);
  else if (before.latitude !== after.latitude || before.longitude !== after.longitude) out.push("The venue's map location was corrected — check directions before you travel");
  return out;
}

/** Queues a fan-out job (not one email per booking inline) so organizer saves stay fast. */
export async function notifyEventChanged(tx: Tx, before: Event, after: Event) {
  if (after.status !== "published") return;
  const changes = significantEventChanges(before, after);
  if (changes.length === 0) return;
  const changeKey = createHash("sha256")
    .update(JSON.stringify([after.startsAt.toISOString(), after.endsAt.toISOString(), after.timezone, after.venueName, after.venueAddress, after.city, after.latitude, after.longitude]))
    .digest("hex")
    .slice(0, 16);
  await enqueueJob(tx, "email.event_update_fanout", { eventId: after.id, changeKey, changes }, { dedupeKey: `event_update:${after.id}:${changeKey}` });
}

export async function fanOutEventUpdate(payload: { eventId: string; changeKey: string; changes: string[] }) {
  const rows = await db
    .select({ id: bookings.id, email: bookings.buyerEmail })
    .from(bookings)
    .where(and(eq(bookings.eventId, payload.eventId), eq(bookings.status, "confirmed")));
  for (let i = 0; i < rows.length; i += 200) {
    await db.transaction(async (tx) => {
      for (const b of rows.slice(i, i + 200)) {
        await queueEmail(tx, {
          kind: "event_updated",
          toEmail: b.email,
          bookingId: b.id,
          eventId: payload.eventId,
          dedupeKey: `event_updated:${b.id}:${payload.changeKey}`,
          metadata: { changes: payload.changes },
        });
      }
    });
  }
}

// ─── Reminders ───────────────────────────────────────────────────────────────

export const REMINDER_LEAD_MS = 24 * 3600_000;
/** Don't remind when the event is about to start anyway. */
export const REMINDER_MIN_LEAD_MS = 2 * 3600_000;

/**
 * One reminder per confirmed booking, ~24h before the event (times are stored in
 * UTC; templates render them in the event's own time zone). Bookings made inside
 * the window already got their confirmation recently, so they're skipped. The
 * dedupe key includes the start time, so a rescheduled event gets a new reminder.
 */
export async function scheduleEventReminders(now = new Date(), limit = 500) {
  const rows = await db
    .select({ id: bookings.id, email: bookings.buyerEmail, eventId: events.id, startsAt: events.startsAt })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(events.status, "published"),
        gt(events.startsAt, new Date(now.getTime() + REMINDER_MIN_LEAD_MS)),
        lte(events.startsAt, new Date(now.getTime() + REMINDER_LEAD_MS)),
        sql`${bookings.confirmedAt} < ${events.startsAt} - interval '24 hours'`,
        sql`not exists (select 1 from ${emailDeliveries} d where d.dedupe_key = 'event_reminder:' || ${bookings.id} || ':' || extract(epoch from ${events.startsAt})::bigint)`,
      ),
    )
    .limit(limit);
  let queued = 0;
  for (const r of rows) {
    const id = await db.transaction((tx) =>
      queueEmail(tx, {
        kind: "event_reminder",
        toEmail: r.email,
        bookingId: r.id,
        eventId: r.eventId,
        dedupeKey: `event_reminder:${r.id}:${Math.floor(r.startsAt.getTime() / 1000)}`,
      }),
    );
    if (id) queued++;
  }
  return queued;
}

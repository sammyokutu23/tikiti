import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, organizerProfiles, paymentTransactions, platformSettings, ticketTypes, users, type Booking } from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { createCheckout } from "@/server/bookings/checkout";
import type { EmailTransport, OutgoingEmail } from "@/server/email/transport";
import { handlePaymentWebhook, startPayment } from "@/server/payments/service";
import { buildMockCallback, MOCK_SIGNATURE_HEADER, type MockOutcome } from "@/server/payments/providers/mock";

export const sentEmails: OutgoingEmail[] = [];
export const memoryTransport: EmailTransport = {
  name: "memory",
  async send(msg) {
    sentEmails.push(msg);
    return { status: "captured", messageId: `mem-${sentEmails.length}`, transport: "memory" };
  },
};
/** Emails sent to buyers (organizer notifications filtered out). */
export const customerEmails = () => sentEmails.filter((m) => !String(m.tags?.kind ?? "").startsWith("organizer_"));
export const failingTransport: EmailTransport = {
  name: "failing",
  async send() {
    throw new Error("SMTP connection refused (simulated)");
  },
};

export async function resetDb() {
  await db.execute(sql`TRUNCATE audit_logs, jobs, email_provider_events, email_suppressions, email_deliveries, platform_settings, ledger_entries, refunds,
    check_ins, tickets, payment_events, payment_transactions, booking_items, bookings, ticket_types,
    event_reports, events, organizer_profiles, password_reset_tokens, sessions, users CASCADE`);
  await db.insert(platformSettings).values({ key: "commission_bps", value: 500 });
  sentEmails.length = 0;
}

let n = 0;
export async function makeUser(role: "customer" | "organizer" | "admin" = "customer") {
  n++;
  const [u] = await db
    .insert(users)
    .values({ email: `user${n}-${randomToken(4)}@test.dev`, name: `Test User ${n}`, role })
    .returning();
  return u;
}

export async function makeOrganizer(status: "verified" | "pending" = "verified") {
  const user = await makeUser(status === "verified" ? "organizer" : "customer");
  const [organizer] = await db
    .insert(organizerProfiles)
    .values({
      userId: user.id,
      displayName: `Org ${user.name}`,
      slug: `org-${randomToken(6).toLowerCase()}`,
      contactEmail: user.email,
      contactPhone: "254700000000",
      verificationStatus: status,
    })
    .returning();
  return { user, organizer };
}

export async function makeEvent(
  organizerId: string,
  types: { name: string; priceKes: number; capacity: number; maxPerOrder?: number }[] = [{ name: "Regular", priceKes: 1000, capacity: 100 }],
  location: { lat: number; lng: number } | null = { lat: -1.28868, lng: 36.82361 },
) {
  const start = new Date(Date.now() + 7 * 86_400_000);
  const [event] = await db
    .insert(events)
    .values({
      organizerId,
      slug: `ev-${randomToken(8).toLowerCase()}`,
      title: "Test Event",
      description: "A test event description",
      category: "music",
      venueName: "Test Venue",
      city: "Nairobi",
      startsAt: start,
      endsAt: new Date(start.getTime() + 4 * 3600_000),
      status: "published",
      publishedAt: new Date(),
      refundPolicy: "Standard",
      latitude: location?.lat ?? null,
      longitude: location?.lng ?? null,
      locationConfirmedAt: location ? new Date() : null,
    })
    .returning();
  const tts = await db
    .insert(ticketTypes)
    .values(
      types.map((t, i) => ({
        eventId: event.id,
        name: t.name,
        priceMinor: t.priceKes * 100,
        capacity: t.capacity,
        maxPerOrder: t.maxPerOrder ?? 10,
        sortOrder: i,
      })),
    )
    .returning();
  return { event, ticketTypes: tts };
}

export function checkout(eventId: string, lines: [string, number][], opts: { userId?: string | null; email?: string; key?: string } = {}) {
  return createCheckout(
    {
      eventId,
      items: lines.map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity })),
      buyerName: "Jane Wanjiru",
      buyerEmail: opts.email ?? "jane@example.com",
      buyerPhone: "254712345678",
      idempotencyKey: opts.key ?? `k-${randomToken(12)}`,
    },
    opts.userId ?? null,
  );
}

export async function beginPayment(booking: Booking) {
  const { paymentId } = await startPayment({
    booking,
    method: "mpesa",
    payerPhone: "254712345678",
    idempotencyKey: `p-${randomToken(12)}`,
    returnUrl: "/",
  });
  const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, paymentId));
  return p;
}

export async function sendCallback(
  providerReference: string,
  status: MockOutcome,
  amountMinor: number,
  opts: { eventId?: string; signature?: string } = {},
) {
  const cb = buildMockCallback({ providerReference, status, amountMinor, currency: "KES", eventId: opts.eventId });
  return handlePaymentWebhook("mock", cb.body, new Headers({ [MOCK_SIGNATURE_HEADER]: opts.signature ?? cb.signature }));
}

/** Full happy path: checkout → payment → verified webhook. */
export async function buyTickets(eventId: string, lines: [string, number][], opts: { userId?: string | null; email?: string } = {}) {
  const booking = await checkout(eventId, lines, opts);
  if (booking.totalMinor === 0) return booking;
  const p = await beginPayment(booking);
  await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
  return booking;
}

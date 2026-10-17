/**
 * Resend email delivery — against a fake Resend API (global fetch stub).
 * Nothing here talks to the real Resend service, and no real email is sent.
 */
import { createHmac, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { bookings, emailDeliveries, emailProviderEvents, emailSuppressions, jobs, paymentTransactions, tickets } from "@/db/schema";
import { verifyBookingAccessToken } from "@/server/bookings/access";
import { confirmBooking, lockBooking } from "@/server/bookings/lifecycle";
import { handleClerkEmailEvent } from "@/server/email/clerk";
import { retryConfigFailures, retryDelivery, refreshDeliveryStatus } from "@/server/email/admin";
import { receiveResendWebhook } from "@/server/email/events";
import { notifyEventChanged, scheduleEventReminders } from "@/server/email/notify";
import { queueEmail } from "@/server/email/queue";
import { classifyResendError, resendConfig } from "@/server/email/resend";
import { setEmailTransportOverride } from "@/server/email/transport";
import { processDueJobs } from "@/server/jobs/queue";
import { beginPayment, buyTickets, checkout, makeEvent, makeOrganizer, makeUser, memoryTransport, resetDb, sendCallback } from "./helpers";

// ─── Fake Resend API ─────────────────────────────────────────────────────────

type Mode = "ok" | "rate_limit" | "invalid_key" | "reject" | "server_error" | "lost_response" | "hang";
type SentMail = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
  attachments?: { filename: string; content: string; content_type: string }[];
  tags?: { name: string; value: string }[];
};

const fake = {
  modes: [] as Mode[],
  fallback: "ok" as Mode,
  mailbox: [] as SentMail[],
  requests: [] as { key: string | null; body: string }[],
  byKey: new Map<string, { id: string; body: string }>(),
  n: 0,
  lastEvent: "delivered",
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (!url.startsWith("https://api.resend.com")) throw new Error(`unexpected fetch ${url}`);
  const path = new URL(url).pathname;
  if (path === "/emails" && init?.method === "POST") {
    const key = new Headers(init.headers).get("Idempotency-Key");
    const body = String(init.body);
    fake.requests.push({ key, body });
    // Scripted failures target the buyer's ticket email; other emails just use the fallback.
    const kind = (JSON.parse(body).tags as { name: string; value: string }[] | undefined)?.find((t) => t.name === "kind")?.value;
    const mode = (kind === "booking_confirmation" ? fake.modes.shift() : undefined) ?? fake.fallback;
    if (mode === "hang") return new Promise<Response>(() => {});
    if (mode === "rate_limit") return json(429, { statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests" }, { "retry-after": "30" });
    if (mode === "invalid_key") return json(403, { statusCode: 403, name: "invalid_api_key", message: "API key is invalid" });
    if (mode === "reject") return json(403, { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address" });
    if (mode === "server_error") return json(500, { statusCode: 500, name: "internal_server_error", message: "Unexpected error" });
    // Idempotency: same key + same body → same email; same key + different body → 409.
    const prev = key ? fake.byKey.get(key) : undefined;
    if (prev) {
      if (prev.body !== body) return json(409, { statusCode: 409, name: "invalid_idempotent_request", message: "Same idempotency key, different payload" });
      return json(200, { id: prev.id });
    }
    const id = `re_msg_${++fake.n}`;
    if (key) fake.byKey.set(key, { id, body });
    fake.mailbox.push({ id, ...JSON.parse(body) });
    if (mode === "lost_response") throw new TypeError("fetch failed"); // accepted, but the reply never arrived
    return json(200, { id });
  }
  if (path.startsWith("/emails/") && (!init?.method || init.method === "GET")) return json(200, { id: path.split("/")[2], last_event: fake.lastEvent });
  if (path === "/domains") return json(200, { data: [{ id: "d1", name: "tikiti.example", status: "verified" }] });
  return json(404, { statusCode: 404, name: "not_found", message: "Not found" });
}

const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const ENV = {
  EMAIL_TRANSPORT: "resend",
  RESEND_API_KEY: "re_test_0123456789abcdef",
  RESEND_FROM_EMAIL: "tickets@tikiti.example",
  RESEND_FROM_NAME: "Tikiti Tickets",
  RESEND_REPLY_TO: "help@tikiti.example",
  RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
  RESEND_TIMEOUT_MS: "3000",
};

function signedHeaders(body: string, opts: { id?: string; secret?: string; at?: number } = {}) {
  const id = opts.id ?? `msg_${randomBytes(8).toString("hex")}`;
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const key = Buffer.from((opts.secret ?? WEBHOOK_SECRET).replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" });
}

function webhook(type: string, data: Record<string, unknown>, opts: { id?: string; createdAt?: Date } = {}) {
  const body = JSON.stringify({ type, created_at: (opts.createdAt ?? new Date()).toISOString(), data });
  return receiveResendWebhook(body, signedHeaders(body, { id: opts.id }));
}

/** Runs due jobs (twice: a pass can enqueue follow-up work). */
async function deliver() {
  await processDueJobs(20);
  await processDueJobs(20);
}
const makeJobsDue = () => db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.status, "pending"));

async function confirmationDelivery(bookingId: string) {
  const [d] = await db
    .select()
    .from(emailDeliveries)
    .where(and(eq(emailDeliveries.bookingId, bookingId), eq(emailDeliveries.kind, "booking_confirmation")));
  return d;
}
const toBuyer = () => fake.mailbox.filter((m) => m.to.includes("jane@example.com"));
const kindOf = (body: string) => (JSON.parse(body).tags as { name: string; value: string }[]).find((t) => t.name === "kind")?.value;
const ticketRequests = (reference: string) => fake.requests.filter((r) => kindOf(r.body) === "booking_confirmation" && r.body.includes(reference));

async function paidBooking(qty: [number, number] = [2, 0]) {
  const { organizer } = await makeOrganizer();
  const { event, ticketTypes: tts } = await makeEvent(organizer.id, [
    { name: "Regular", priceKes: 1000, capacity: 100 },
    { name: "VIP", priceKes: 3000, capacity: 20 },
  ]);
  const lines: [string, number][] = [];
  if (qty[0]) lines.push([tts[0].id, qty[0]]);
  if (qty[1]) lines.push([tts[1].id, qty[1]]);
  const booking = await buyTickets(event.id, lines);
  return { organizer, event, booking };
}

const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setEmailTransportOverride(memoryTransport);
});

beforeEach(async () => {
  await resetDb();
  setEmailTransportOverride(null); // use the real Resend transport (against the fake API)
  vi.stubGlobal("fetch", fakeFetch);
  Object.assign(fake, { modes: [], fallback: "ok", mailbox: [], requests: [], byKey: new Map(), n: 0, lastEvent: "delivered" });
  process.env.RESEND_API_KEY = ENV.RESEND_API_KEY;
  delete process.env.EMAIL_MAX_ATTACHMENT_BYTES;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Configuration ───────────────────────────────────────────────────────────

describe("Resend configuration", () => {
  it("validates required settings without leaking the key", () => {
    const cfg = (e: Record<string, string>) => resendConfig(e as NodeJS.ProcessEnv);
    expect(() => cfg({})).toThrow(/RESEND_API_KEY, RESEND_FROM_EMAIL/);
    expect(() => cfg({ RESEND_API_KEY: "sk_live_x", RESEND_FROM_EMAIL: "a@b.co" })).toThrow(/doesn't look like a Resend key/);
    expect(() => cfg({ RESEND_API_KEY: "re_abcdefghij", RESEND_FROM_EMAIL: "Tikiti <a@b.co>" })).toThrow(/plain address/);
    expect(() => cfg({ RESEND_API_KEY: "re_abcdefghij", RESEND_FROM_EMAIL: "a@b.co", RESEND_WEBHOOK_SECRET: "nope" })).toThrow(/whsec_/);
    expect(() => cfg({ RESEND_API_KEY: "re_abcdefghij", RESEND_FROM_EMAIL: "a@b.co", NODE_ENV: "production", APP_BASE_URL: "http://x.co" })).toThrow(/https/);
    try {
      cfg({ RESEND_API_KEY: "re_secretvalue123", RESEND_FROM_EMAIL: "bad" });
    } catch (e) {
      expect((e as Error).message).not.toContain("re_secretvalue123");
    }
    const c = cfg({ RESEND_API_KEY: "re_abcdefghij", RESEND_FROM_EMAIL: "onboarding@resend.dev", RESEND_FROM_NAME: 'Evil" <x@y.z>\r\nBcc: a@b.c' });
    expect(c.testSender).toBe(true);
    expect(c.from).toBe('"Evil x@y.zBcc: a@b.c" <onboarding@resend.dev>'); // no header/quote injection
  });

  it("classifies provider errors into retry decisions", () => {
    expect(classifyResendError({ name: "invalid_api_key", statusCode: 403 }, null)).toMatchObject({ category: "config", retryable: false });
    expect(classifyResendError({ name: "validation_error", statusCode: 403 }, null)).toMatchObject({ category: "rejected", retryable: false });
    expect(classifyResendError({ name: "rate_limit_exceeded", statusCode: 429 }, { "retry-after": "12" })).toMatchObject({ category: "rate_limited", retryable: true, retryAfterMs: 12_000 });
    expect(classifyResendError({ name: "internal_server_error", statusCode: 500 }, null)).toMatchObject({ retryable: true, uncertain: true });
    expect(classifyResendError({ name: "application_error", statusCode: null as unknown as number }, null)).toMatchObject({ category: "uncertain", retryable: true });
    expect(classifyResendError({ name: "invalid_idempotent_request", statusCode: 409 }, null)).toMatchObject({ category: "idempotency_conflict", retryable: false });
    expect(classifyResendError({ name: "daily_quota_exceeded", statusCode: 429 }, null)).toMatchObject({ category: "quota", retryable: true });
  });
});

// ─── Ticket delivery ─────────────────────────────────────────────────────────

describe("ticket confirmation email", () => {
  it("1–3. sends one branded email with a valid PDF of every ticket (multi-type booking)", async () => {
    const { booking } = await paidBooking([2, 1]);
    await deliver();

    const mails = toBuyer();
    expect(mails).toHaveLength(1);
    const m = mails[0];
    expect(m.from).toBe('"Tikiti Tickets" <tickets@tikiti.example>');
    expect(m.reply_to).toBe("help@tikiti.example");
    expect(m.subject).toBe(`Your tickets for Test Event — ${booking.reference}`);
    expect(m.html).toContain(booking.reference);
    expect(m.html).toContain("Test Venue");
    expect(m.html).toContain("Get directions");
    expect(m.html).toContain("Ticket 3 of 3");
    expect(m.html).toContain("VIP");
    expect(m.text).toContain(`Booking reference: ${booking.reference}`);
    expect(m.tags).toEqual(expect.arrayContaining([{ name: "kind", value: "booking_confirmation" }]));

    expect(m.attachments).toHaveLength(1);
    const a = m.attachments![0];
    expect(a.content_type).toBe("application/pdf");
    expect(a.filename).toMatch(/^tikosoko-[a-z0-9-]+-[A-Z0-9-]+\.pdf$/);
    const pdf = await PDFDocument.load(Buffer.from(a.content, "base64"));
    expect(pdf.getPageCount()).toBe(3); // one page per ticket

    const d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "accepted", transport: "resend", providerMessageId: m.id, attachmentCount: 1, attempts: 1 });
    expect(ticketRequests(booking.reference)[0].key).toBe(`tikiti-email-${d.id}`);
    // Nothing sensitive stored: no body, no attachment.
    expect(JSON.stringify(d)).not.toContain("%PDF");
  });

  it("falls back to the secure download link when the PDF exceeds the attachment limit", async () => {
    process.env.EMAIL_MAX_ATTACHMENT_BYTES = "1000";
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    const [m] = toBuyer();
    expect(m.attachments ?? []).toHaveLength(0);
    expect(m.html).toContain("Download tickets");
    expect(m.html).toContain(`/bookings/${booking.reference}?access=`);
    expect(await confirmationDelivery(booking.id)).toMatchObject({ status: "accepted", attachmentCount: 0 });
  });

  it("18. the ticket link is a signed, booking-specific token and identical across retries", async () => {
    const { booking } = await paidBooking([1, 0]);
    const other = await paidBooking([1, 0]);
    fake.modes = ["server_error", "server_error"]; // first attempt of both bookings' emails
    await deliver();
    await makeJobsDue();
    await deliver();
    const reqs = ticketRequests(booking.reference);
    expect(reqs).toHaveLength(2);
    expect(reqs[0].body).toBe(reqs[1].body); // deterministic payload → Resend idempotency holds
    const token = decodeURIComponent(/\?access=([^"&\s]+)/.exec(JSON.parse(reqs[1].body).html)![1]);
    expect(verifyBookingAccessToken(token, booking.id)).toBe(true);
    expect(verifyBookingAccessToken(token, other.booking.id)).toBe(false);
    expect(verifyBookingAccessToken(`${token.slice(0, -2)}xx`, booking.id)).toBe(false);
    expect(token).not.toContain("@");
  });

  it("escapes organizer-supplied text in templates", async () => {
    const { event, booking } = await paidBooking([1, 0]);
    await db.update(bookings).set({ buyerName: `<img src=x onerror=alert(1)> Jane` }).where(eq(bookings.id, booking.id));
    const { events } = await import("@/db/schema");
    await db.update(events).set({ title: `<script>alert("x")</script>` }).where(eq(events.id, event.id));
    await deliver();
    const m = fake.mailbox.find((x) => x.to.includes("jane@example.com"))!;
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain("&lt;script&gt;");
  });
});

// ─── Failures, retries, idempotency ──────────────────────────────────────────

describe("delivery failures and retries", () => {
  it("4. a missing recipient is recorded as failed and never sent", async () => {
    const id = await db.transaction((tx) => queueEmail(tx, { kind: "booking_access_link", toEmail: "", dedupeKey: "x" }));
    const [d] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, id!));
    expect(d).toMatchObject({ status: "failed", lastErrorCategory: "invalid_recipient" });
    expect(await db.$count(jobs)).toBe(0);
    await deliver();
    expect(fake.requests).toHaveLength(0);
  });

  it("5. missing configuration fails fast, keeps the booking, and is recoverable after the fix", async () => {
    delete process.env.RESEND_API_KEY;
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    let d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "failed", lastErrorCategory: "config", attempts: 1 });
    expect(d.lastError).toMatch(/Missing Resend configuration: RESEND_API_KEY/);
    expect((await db.select().from(bookings).where(eq(bookings.id, booking.id)))[0].status).toBe("confirmed");
    expect(fake.requests).toHaveLength(0);

    process.env.RESEND_API_KEY = ENV.RESEND_API_KEY;
    const admin = await makeUser("admin");
    expect(await retryConfigFailures(admin.id)).toBeGreaterThanOrEqual(1);
    await deliver();
    d = await confirmationDelivery(booking.id);
    expect(d.status).toBe("accepted");
    expect(toBuyer()).toHaveLength(1);
  });

  it("6. an invalid API key is not retried automatically", async () => {
    fake.fallback = "invalid_key";
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    await makeJobsDue();
    await deliver();
    const d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "failed", lastErrorCategory: "config", attempts: 1 });
    const [job] = await db.select().from(jobs).where(eq(jobs.type, "email.send")).limit(1);
    expect(job.status).toBe("failed");
  });

  it("7. a Resend rejection (e.g. unverified sender) fails permanently with the provider's reason", async () => {
    fake.fallback = "reject";
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    const d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "failed", lastErrorCategory: "rejected", attempts: 1 });
    expect(d.lastError).toMatch(/validation_error.*testing emails/);
  });

  it("8. rate limiting backs off for at least Retry-After, then sends", async () => {
    fake.modes = ["rate_limit"];
    const { booking } = await paidBooking([1, 0]);
    const before = Date.now();
    await deliver();
    let d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "retry_pending", lastErrorCategory: "rate_limited" });
    const [job] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `email:${d.id}:0`));
    expect(job.runAt.getTime()).toBeGreaterThanOrEqual(before + 30_000);
    await makeJobsDue();
    await deliver();
    d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "accepted", attempts: 2 });
  });

  it("9. a timeout is treated as uncertain and retried with the same idempotency key", async () => {
    fake.modes = ["hang"];
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    let d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "retry_pending", lastErrorCategory: "uncertain" });
    expect(d.lastError).toMatch(/timed out/);
    await makeJobsDue();
    await deliver();
    d = await confirmationDelivery(booking.id);
    expect(d.status).toBe("accepted");
    const keys = ticketRequests(booking.reference).map((r) => r.key);
    expect(keys).toEqual([`tikiti-email-${d.id}`, `tikiti-email-${d.id}`]);
  }, 20_000);

  it("10. accepted-but-reply-lost is retried safely: Resend's idempotency returns the same email, no duplicate", async () => {
    fake.modes = ["lost_response"];
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    expect(await confirmationDelivery(booking.id)).toMatchObject({ status: "retry_pending", lastErrorCategory: "uncertain" });
    await makeJobsDue();
    await deliver();
    const d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "accepted", providerMessageId: toBuyer()[0].id });
    expect(toBuyer()).toHaveLength(1); // the recipient got exactly one email
  });

  it("11. duplicate confirmations are prevented (replayed transition, re-run job, admin retry of a sent email)", async () => {
    const { booking } = await paidBooking([2, 0]);
    await deliver();
    await db.transaction(async (tx) => {
      const locked = await lockBooking(tx, booking.id);
      await confirmBooking(tx, locked!, { free: false });
    });
    const d = await confirmationDelivery(booking.id);
    await db.update(jobs).set({ status: "pending", runAt: new Date() }).where(eq(jobs.dedupeKey, `email:${d.id}:0`));
    await deliver();
    expect(await db.$count(emailDeliveries, and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")))).toBe(1);
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(2);
    expect(toBuyer()).toHaveLength(1);
    const admin = await makeUser("admin");
    await expect(retryDelivery(d.id, admin.id)).rejects.toThrow(/can't be retried in place/);
  });

  it("12. a successful payment survives a total email outage and the email is recoverable", async () => {
    fake.fallback = "server_error";
    const { booking } = await paidBooking([1, 0]);
    for (let i = 0; i < 6; i++) {
      await makeJobsDue();
      await deliver();
    }
    let d = await confirmationDelivery(booking.id);
    expect(d).toMatchObject({ status: "failed", lastErrorCategory: "provider_unavailable", attempts: 6 });
    const [b] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(b).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.bookingId, booking.id));
    expect(p.status).toBe("succeeded");
    expect(await db.$count(paymentTransactions, eq(paymentTransactions.bookingId, booking.id))).toBe(1);

    fake.fallback = "ok";
    const admin = await makeUser("admin");
    await retryDelivery(d.id, admin.id);
    await deliver();
    d = await confirmationDelivery(booking.id);
    expect(d.status).toBe("accepted");
    expect(toBuyer()).toHaveLength(1);
  });
});

// ─── Payment sequencing ──────────────────────────────────────────────────────

describe("emails follow verified payment only", () => {
  it("13. nothing is sent while payment is pending; the delayed callback triggers the email", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const booking = await checkout(event.id, [[tt.id, 2]]);
    const p = await beginPayment(booking);
    await deliver();
    expect(toBuyer()).toHaveLength(0);
    expect(await db.$count(emailDeliveries, eq(emailDeliveries.bookingId, booking.id))).toBe(0);

    await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
    await deliver();
    expect(toBuyer()).toHaveLength(1);
  });

  it("14. duplicate payment callbacks produce one confirmation email", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const p = await beginPayment(booking);
    await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_dup" });
    await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_dup" });
    await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_other" });
    await deliver();
    expect(toBuyer()).toHaveLength(1);
    // The organizer is told once as well.
    expect(fake.mailbox.filter((m) => m.tags?.some((t) => t.value === "organizer_new_sale"))).toHaveLength(1);
  });
});

// ─── Webhooks ────────────────────────────────────────────────────────────────

describe("Resend webhooks", () => {
  async function sentConfirmation() {
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    return { booking, d: await confirmationDelivery(booking.id) };
  }

  it("records delivered, ignores stale out-of-order events", async () => {
    const { booking, d } = await sentConfirmation();
    const t0 = new Date();
    expect((await webhook("email.delivered", { email_id: d.providerMessageId }, { createdAt: new Date(t0.getTime() + 2000) })).status).toBe(200);
    // A late "sent"/"delayed" must not undo "delivered".
    await webhook("email.sent", { email_id: d.providerMessageId }, { createdAt: t0 });
    await webhook("email.delivery_delayed", { email_id: d.providerMessageId }, { createdAt: t0 });
    const after = await confirmationDelivery(booking.id);
    expect(after.status).toBe("delivered");
    expect(after.deliveredAt).not.toBeNull();
  });

  it("15. a hard bounce marks the delivery, suppresses the address, and blocks later automatic emails", async () => {
    const { booking, d } = await sentConfirmation();
    const r = await webhook("email.bounced", {
      email_id: d.providerMessageId,
      to: ["jane@example.com"],
      bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist" },
    });
    expect(r.body).toMatchObject({ outcome: "hard_bounce" });
    expect(await confirmationDelivery(booking.id)).toMatchObject({ status: "bounced", lastErrorCategory: "hard_bounce" });
    const [s] = await db.select().from(emailSuppressions);
    expect(s).toMatchObject({ email: "jane@example.com", reason: "hard_bounce" });
    // Stored event keeps no recipient list.
    const [ev] = await db.select().from(emailProviderEvents);
    expect(JSON.stringify(ev.detail)).not.toContain("jane@example.com");

    // A later email to the same address is suppressed without calling Resend.
    const before = fake.requests.length;
    await db.transaction((tx) => queueEmail(tx, { kind: "booking_access_link", toEmail: "JANE@example.com", bookingId: booking.id }));
    await deliver();
    expect(fake.requests.length).toBe(before);
    const [last] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.kind, "booking_access_link"));
    expect(last.status).toBe("suppressed");
  });

  it("a spam complaint blocks optional emails but not ticket-critical ones", async () => {
    const { booking, d } = await sentConfirmation();
    await webhook("email.complained", { email_id: d.providerMessageId });
    expect(await confirmationDelivery(booking.id)).toMatchObject({ status: "complained" });
    await db.transaction(async (tx) => {
      await queueEmail(tx, { kind: "event_reminder", toEmail: "jane@example.com", bookingId: booking.id });
      await queueEmail(tx, { kind: "booking_access_link", toEmail: "jane@example.com", bookingId: booking.id });
    });
    await deliver();
    const rows = await db.select().from(emailDeliveries).where(eq(emailDeliveries.bookingId, booking.id));
    expect(rows.find((r) => r.kind === "event_reminder")!.status).toBe("suppressed");
    expect(rows.find((r) => r.kind === "booking_access_link")!.status).toBe("accepted");
  });

  it("16. rejects invalid signatures, wrong secrets and stale timestamps", async () => {
    const { d } = await sentConfirmation();
    const body = JSON.stringify({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: d.providerMessageId } });
    const tampered = signedHeaders(body);
    expect((await receiveResendWebhook(body.replace("delivered", "bounced"), tampered)).status).toBe(401);
    expect((await receiveResendWebhook(body, signedHeaders(body, { secret: `whsec_${randomBytes(24).toString("base64")}` }))).status).toBe(401);
    expect((await receiveResendWebhook(body, signedHeaders(body, { at: Date.now() - 10 * 60_000 }))).status).toBe(401);
    expect((await receiveResendWebhook(body, new Headers())).status).toBe(401);
    expect(await db.$count(emailProviderEvents)).toBe(0);
    expect((await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, d.id)))[0].status).toBe("accepted");

    const saved = process.env.RESEND_WEBHOOK_SECRET;
    delete process.env.RESEND_WEBHOOK_SECRET;
    expect((await receiveResendWebhook(body, signedHeaders(body))).status).toBe(503);
    process.env.RESEND_WEBHOOK_SECRET = saved;
  });

  it("17. duplicate webhook deliveries are processed once", async () => {
    const { d } = await sentConfirmation();
    const r1 = await webhook("email.bounced", { email_id: d.providerMessageId, bounce: { type: "Permanent", message: "x" } }, { id: "msg_same" });
    const r2 = await webhook("email.bounced", { email_id: d.providerMessageId, bounce: { type: "Permanent", message: "x" } }, { id: "msg_same" });
    expect(r1.body).toMatchObject({ outcome: "hard_bounce" });
    expect(r2.body).toMatchObject({ duplicate: true });
    expect(await db.$count(emailProviderEvents)).toBe(1);
    expect(await db.$count(emailSuppressions)).toBe(1);
  });

  it("an event that beats the send response is applied once the id is stored", async () => {
    // Fake ids are sequential; the booking produces two emails (buyer + organizer): re_msg_1 and re_msg_2.
    await webhook("email.delivered", { email_id: "re_msg_1" });
    await webhook("email.delivered", { email_id: "re_msg_2" });
    expect((await db.select().from(emailProviderEvents)).map((e) => e.outcome)).toEqual(["unmatched", "unmatched"]);
    const { booking } = await paidBooking([1, 0]);
    await deliver();
    const d = await confirmationDelivery(booking.id);
    expect(["re_msg_1", "re_msg_2"]).toContain(d.providerMessageId);
    expect(d.status).toBe("delivered");
    expect((await db.select().from(emailProviderEvents)).every((e) => e.appliedAt !== null)).toBe(true);
  });

  it("admins can poll Resend for the latest status", async () => {
    const { booking, d } = await sentConfirmation();
    fake.lastEvent = "delivered";
    expect(await refreshDeliveryStatus(d.id)).toBe("delivered");
    expect((await confirmationDelivery(booking.id)).status).toBe("delivered");
  });
});

// ─── Other transactional emails ──────────────────────────────────────────────

describe("other transactional emails", () => {
  it("event time/venue changes notify each confirmed buyer once per change", async () => {
    const { event, booking } = await paidBooking([1, 0]);
    await deliver();
    const moved = { ...event, startsAt: new Date(event.startsAt.getTime() + 86_400_000), venueName: "New Hall" };
    await db.transaction((tx) => notifyEventChanged(tx, event, moved));
    await db.transaction((tx) => notifyEventChanged(tx, event, moved)); // same change again → deduped
    await db.transaction((tx) => notifyEventChanged(tx, event, { ...event, summary: "typo fix" })); // not significant
    await deliver();
    const updates = fake.mailbox.filter((m) => m.tags?.some((t) => t.value === "event_updated"));
    expect(updates).toHaveLength(1);
    expect(updates[0].html).toContain("New venue: New Hall");
    expect(updates[0].html).toContain(booking.reference);
  });

  it("reminders go out once, ~24h before, in the event's time zone", async () => {
    const { event, booking } = await paidBooking([1, 0]);
    await deliver();
    // Booked well in advance; the event is now 20h away.
    await db.update(bookings).set({ confirmedAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(bookings.id, booking.id));
    const { events } = await import("@/db/schema");
    await db.update(events).set({ startsAt: new Date(Date.now() + 20 * 3600_000), timezone: "Africa/Nairobi" }).where(eq(events.id, event.id));
    expect(await scheduleEventReminders()).toBe(1);
    expect(await scheduleEventReminders()).toBe(0);
    await deliver();
    const reminders = fake.mailbox.filter((m) => m.tags?.some((t) => t.value === "event_reminder"));
    expect(reminders).toHaveLength(1);
    expect(reminders[0].html).toMatch(/EAT|GMT\+3|Nairobi/);
  });

  it("19. account emails rendered by Clerk are delivered once and their content isn't kept", async () => {
    const evt = {
      id: "ema_123",
      to_email_address: "new.user@example.com",
      subject: "123456 is your verification code",
      body: "<p>Your code is <b>123456</b></p>",
      body_plain: "Your code is 123456",
      slug: "verification_code",
      delivered_by_clerk: false,
    };
    expect(await handleClerkEmailEvent({ ...evt, delivered_by_clerk: true })).toBe("delivered_by_clerk");
    expect(await handleClerkEmailEvent(evt)).toBe("queued");
    expect(await handleClerkEmailEvent(evt)).toBe("duplicate"); // Clerk retried the webhook
    await deliver();
    const m = fake.mailbox.filter((x) => x.to.includes("new.user@example.com"));
    expect(m).toHaveLength(1);
    expect(m[0].subject).toBe(evt.subject);
    const [job] = await db.select().from(jobs).where(eq(jobs.type, "email.send"));
    expect(JSON.stringify(job.payload)).not.toContain("123456"); // secret dropped after send
    const [d] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.kind, "account_email"));
    expect(JSON.stringify(d)).not.toContain("123456");
  });

  it("an M-Pesa failure reported later emails the buyer; it's skipped if the booking got paid meanwhile", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const p = await beginPayment(booking);
    const { applyPaymentResult } = await import("@/server/payments/service");
    await applyPaymentResult(p.id, { status: "cancelled", amountMinor: null, currency: undefined, receipt: null, resultCode: "1032", resultDesc: "Cancelled", failureReason: "You cancelled the M-Pesa prompt", source: "callback" });
    await deliver();
    const failed = fake.mailbox.filter((m) => m.tags?.some((t) => t.value === "payment_failed"));
    expect(failed).toHaveLength(1);
    expect(failed[0].html).toContain("You cancelled the M-Pesa prompt");
    expect(failed[0].html).toContain(`/checkout/${booking.reference}?access=`);
  });
});

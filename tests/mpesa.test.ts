/**
 * M-Pesa Express (Daraja) integration tests against a fake Daraja server.
 * Every Daraja HTTP call is answered by `fakeFetch` below. No request reaches
 * Safaricom, so these tests do NOT prove sandbox connectivity.
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  auditLogs,
  bookings,
  emailDeliveries,
  jobs,
  ledgerEntries,
  paymentEvents,
  paymentTransactions,
  refunds,
  tickets,
  ticketTypes,
  type Booking,
  type PaymentTransaction,
} from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { confirmBooking, expireStaleBookings, lockBooking } from "@/server/bookings/lifecycle";
import { setEmailTransportOverride } from "@/server/email/transport";
import { processDueJobs } from "@/server/jobs/queue";
import {
  checkMpesaPaymentStatus,
  MAX_STATUS_CHECKS,
  processMpesaCallbackEvent,
  receiveMpesaCallback,
  reconcileMpesaPayments,
  resolveMpesaPayment,
} from "@/server/payments/mpesa";
import { darajaConfig } from "@/server/payments/providers/daraja/config";
import { darajaTimestamp, resetDarajaTokenCache, stkPassword } from "@/server/payments/providers/daraja/client";
import { interpretResultCode, parseStkCallback } from "@/server/payments/providers/daraja/callback";
import { completeRefund, startPayment } from "@/server/payments/service";
import { checkout, failingTransport, makeEvent, makeOrganizer, makeUser, memoryTransport, resetDb, customerEmails } from "./helpers";

const pdf = vi.hoisted(() => ({ fail: false }));
vi.mock("@/server/tickets/documents", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/tickets/documents")>();
  return {
    ...mod,
    renderBookingPdf: async (id: string, opts?: { createdAt?: Date }) => {
      if (pdf.fail) throw new Error("font file missing (simulated)");
      return mod.renderBookingPdf(id, opts);
    },
  };
});

// ─── Fake Daraja ─────────────────────────────────────────────────────────────

const TOKEN = "cbtok_0123456789abcdefghijklmnop";
const ENV = {
  MPESA_PROVIDER: "daraja",
  DARAJA_ENV: "sandbox",
  DARAJA_CONSUMER_KEY: "test-consumer-key",
  DARAJA_CONSUMER_SECRET: "test-consumer-secret",
  DARAJA_SHORTCODE: "174379",
  DARAJA_PASSKEY: "test-passkey",
  DARAJA_TRANSACTION_TYPE: "CustomerPayBillOnline",
  DARAJA_CALLBACK_URL: "https://tikosoko.example/api/payments/stk/callback",
  DARAJA_CALLBACK_TOKEN: TOKEN,
  DARAJA_VERIFY_CALLBACKS: "true",
  DARAJA_TIMEOUT_MS: "2000",
};

type Reply = { status: number; body: unknown } | "timeout" | "refused";
type Call = { path: string; body: Record<string, unknown> | null; auth: string };

const daraja = {
  calls: [] as Call[],
  n: 0,
  /** Final ResultCode per CheckoutRequestID; absent = still processing. */
  results: new Map<string, string>(),
  oauth: (): Reply => ({ status: 200, body: { access_token: `tok-${++daraja.n}`, expires_in: "3599" } }),
  stk: (): Reply => {
    const n = ++daraja.n;
    return {
      status: 200,
      body: { MerchantRequestID: `mr-${n}`, CheckoutRequestID: `ws_CO_TEST${n}`, ResponseCode: "0", ResponseDescription: "Success. Request accepted for processing", CustomerMessage: "Success" },
    };
  },
  query: (body: Record<string, unknown>): Reply => {
    const code = daraja.results.get(String(body.CheckoutRequestID));
    if (code === undefined) return { status: 500, body: { requestId: "x", errorCode: "500.001.1001", errorMessage: "The transaction is being processed" } };
    return { status: 200, body: { ResponseCode: "0", ResponseDescription: "accepted", MerchantRequestID: "mr", CheckoutRequestID: body.CheckoutRequestID, ResultCode: code, ResultDesc: `result ${code}` } };
  },
};

async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  expect(url.origin).toBe("https://sandbox.safaricom.co.ke"); // never production in tests
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  daraja.calls.push({ path: url.pathname, body, auth: String((init?.headers as Record<string, string>)?.Authorization ?? "") });
  const reply =
    url.pathname === "/oauth/v1/generate" ? daraja.oauth() : url.pathname === "/mpesa/stkpush/v1/processrequest" ? daraja.stk() : url.pathname === "/mpesa/stkpushquery/v1/query" ? daraja.query(body!) : { status: 404, body: {} };
  if (reply === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  if (reply === "refused") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
}

const defaults = { oauth: daraja.oauth, stk: daraja.stk, query: daraja.query };
const defaultStkReply = daraja.stk;
const calls = (path: string) => daraja.calls.filter((c) => c.path.endsWith(path));
const STK = "/processrequest";
const QUERY = "/query";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const saved: Record<string, string | undefined> = {};
beforeEach(async () => {
  await resetDb();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  daraja.calls = [];
  daraja.results.clear();
  Object.assign(daraja, defaults);
  resetDarajaTokenCache();
  setEmailTransportOverride(memoryTransport);
  pdf.fail = false;
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});


async function setup(capacity = 10, priceKes = 1500) {
  const { organizer } = await makeOrganizer();
  const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes, capacity }]);
  return { event, tt };
}

function pay(booking: Booking, opts: { key?: string; phone?: string } = {}) {
  return startPayment({ booking, method: "mpesa", payerPhone: opts.phone ?? "0712 345 678", idempotencyKey: opts.key ?? `pay_${randomToken(12)}`, returnUrl: "/status" });
}

async function payment(id: string) {
  const [p] = await db.select().from(paymentTransactions).where(eq(paymentTransactions.id, id));
  return p;
}
async function reload(id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  return b;
}

function callbackBody(p: Pick<PaymentTransaction, "providerReference" | "merchantRequestId" | "amountMinor">, code: number, opts: { amountKes?: number; receipt?: string; phone?: string } = {}) {
  const stkCallback: Record<string, unknown> = {
    MerchantRequestID: p.merchantRequestId,
    CheckoutRequestID: p.providerReference,
    ResultCode: code,
    ResultDesc: code === 0 ? "The service request is processed successfully." : "Request cancelled by user",
  };
  if (code === 0) {
    stkCallback.CallbackMetadata = {
      Item: [
        { Name: "Amount", Value: opts.amountKes ?? p.amountMinor / 100 },
        { Name: "MpesaReceiptNumber", Value: opts.receipt ?? `TST${randomToken(6).toUpperCase().replace(/[^A-Z0-9]/g, "X")}` },
        { Name: "Balance" },
        { Name: "TransactionDate", Value: 20261012153000 },
        { Name: "PhoneNumber", Value: Number(opts.phone ?? "254712345678") },
      ],
    };
  }
  return JSON.stringify({ Body: { stkCallback } });
}

/** Deliver a callback as Safaricom would, then let the job queue process it. */
async function deliver(body: string, token = TOKEN) {
  const res = await receiveMpesaCallback(body, { token, ip: "196.201.214.200" });
  await processDueJobs(); // verify + apply the callback
  await processDueJobs(); // follow-on jobs it queued (email, refund)
  return res;
}

async function lastEventOutcome() {
  const rows = await db.select().from(paymentEvents).where(eq(paymentEvents.kind, "callback"));
  return rows.at(-1)?.outcome;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Daraja adapter basics", () => {
  it("builds the password and EAT timestamp per the Daraja spec", () => {
    expect(darajaTimestamp(new Date("2026-10-12T21:05:09Z"))).toBe("20261013000509"); // UTC+3
    expect(stkPassword("174379", "pk", "20261013000509")).toBe(Buffer.from("174379pk20261013000509").toString("base64"));
  });

  it("refuses production without the explicit live switch, and never with the sandbox shortcode", () => {
    expect(() => darajaConfig({ ...process.env, DARAJA_ENV: "production" })).toThrow(/DARAJA_LIVE_PAYMENTS_ENABLED/);
    expect(() => darajaConfig({ ...process.env, DARAJA_ENV: "production", DARAJA_LIVE_PAYMENTS_ENABLED: "true" })).toThrow(/sandbox test shortcode/);
    expect(() => darajaConfig({ ...process.env, DARAJA_CALLBACK_URL: "http://tikosoko.example/api/payments/stk/callback" })).toThrow(/HTTPS/);
    expect(darajaConfig().baseUrl).toBe("https://sandbox.safaricom.co.ke");
  });

  it("validates callback structure and maps result codes", () => {
    expect(parseStkCallback("not json")).toEqual({ ok: false, reason: "invalid_json" });
    expect(parseStkCallback(JSON.stringify({ Body: {} }))).toEqual({ ok: false, reason: "missing_stkCallback" });
    const noReceipt = JSON.stringify({ Body: { stkCallback: { MerchantRequestID: "mr-1", CheckoutRequestID: "ws_CO_1", ResultCode: 0, ResultDesc: "ok", CallbackMetadata: { Item: [{ Name: "Amount", Value: 10 }] } } } });
    expect(parseStkCallback(noReceipt)).toEqual({ ok: false, reason: "success_without_receipt" });
    expect(interpretResultCode("1032").status).toBe("cancelled");
    expect(interpretResultCode("1037").status).toBe("expired");
    expect(interpretResultCode("1").status).toBe("failed");
  });
});

describe("M-Pesa STK Push initiation", () => {
  it("1. sends a correct STK Push and leaves the booking pending", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 2]]);
    const { paymentId, redirectUrl } = await pay(booking);
    expect(redirectUrl).toBe("/status");

    const [req] = calls(STK);
    expect(req.auth).toMatch(/^Bearer tok-/);
    expect(req.body).toMatchObject({
      BusinessShortCode: "174379",
      TransactionType: "CustomerPayBillOnline",
      Amount: 3000,
      PartyA: "254712345678",
      PartyB: "174379",
      PhoneNumber: "254712345678",
      CallBackURL: `https://tikosoko.example/api/payments/stk/callback/${TOKEN}`,
    });
    expect(req.body!.Timestamp).toMatch(/^\d{14}$/);
    expect(req.body!.Password).toBe(stkPassword("174379", "test-passkey", String(req.body!.Timestamp)));
    expect(String(req.body!.AccountReference)).toMatch(/^[A-Z0-9]{1,12}$/);
    expect(String(req.body!.TransactionDesc).length).toBeLessThanOrEqual(13);

    const p = await payment(paymentId);
    expect(p).toMatchObject({ status: "pending", provider: "daraja", amountMinor: 300_000, payerPhone: "254712345678", merchantRequestId: expect.stringMatching(/^mr-/) });
    expect(p.providerReference).toMatch(/^ws_CO_TEST/);
    const b = await reload(booking.id);
    expect(b).toMatchObject({ status: "pending", paymentStatus: "pending" });
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);

    // The OAuth token is cached across requests.
    const other = await checkout(event.id, [[tt.id, 1]]);
    await pay(other, { phone: "0722000111" });
    expect(calls("/generate")).toHaveLength(1);
  });

  it("2. rejects an invalid phone number before contacting Daraja", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    await expect(pay(booking, { phone: "0612 345" })).rejects.toThrow(UserError);
    await expect(pay(booking, { phone: "+1 415 555 0100" })).rejects.toThrow(/valid Safaricom/);
    expect(daraja.calls).toHaveLength(0);
    expect(await db.$count(paymentTransactions)).toBe(0);
  });

  it("3. handles a Daraja authentication failure without sending a prompt", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    daraja.oauth = () => ({ status: 400, body: { errorCode: "400.008.01", errorMessage: "Invalid Authentication passed" } });
    await expect(pay(booking)).rejects.toThrow(/temporarily unavailable/);
    expect(calls(STK)).toHaveLength(0);
    const [p] = await db.select().from(paymentTransactions);
    expect(p.status).toBe("failed");
    expect(p.providerResultCode).toBe("auth_failed");
    expect((await reload(booking.id)).status).toBe("pending"); // hold kept; customer may retry
  });

  it("4. records a rejected initiation and allows a clean retry", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    daraja.stk = () => ({ status: 400, body: { requestId: "r", errorCode: "400.002.02", errorMessage: "Bad Request - Invalid PhoneNumber" } });
    await expect(pay(booking)).rejects.toThrow(/didn't accept that phone number/);
    const [failed] = await db.select().from(paymentTransactions);
    expect(failed).toMatchObject({ status: "failed", providerResultCode: "400.002.02" });

    daraja.stk = defaultStkReply;
    const { paymentId } = await pay(booking);
    expect((await payment(paymentId)).status).toBe("pending");

    // Rate-limit / spike-arrest replies are reported as "busy", never as uncertain.
    const b2 = await checkout(event.id, [[tt.id, 1]]);
    daraja.stk = () => ({ status: 500, body: { errorCode: "500.003.02", errorMessage: "Spike Arrest Violation" } });
    await expect(pay(b2)).rejects.toThrow(/busy/);
  });

  it("13. never sends two prompts for one booking (double click, second tab, retry while pending)", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const results = await Promise.all([pay(booking, { key: "pay_same_key_123" }), pay(booking, { key: "pay_same_key_123" }), pay(booking), pay(booking)]);
    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(calls(STK)).toHaveLength(1);
    expect(await db.$count(paymentTransactions)).toBe(1);

    // A later click while the prompt is still open first asks Daraja, and still doesn't re-prompt.
    await db.update(paymentTransactions).set({ createdAt: new Date(Date.now() - 45_000) });
    const again = await pay(booking);
    expect(again.paymentId).toBe(results[0].paymentId);
    expect(calls(QUERY)).toHaveLength(1);
    expect(calls(STK)).toHaveLength(1);
  });

  it("refuses non-whole-shilling or over-limit totals for M-Pesa", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    await expect(pay({ ...booking, totalMinor: 150_050 })).rejects.toThrow(/whole shillings/);
    await expect(pay({ ...booking, totalMinor: 30_000_000 })).rejects.toThrow(/limited to KES 250,000/);
    expect(daraja.calls).toHaveLength(0);
  });

  it("an initiation timeout blocks new prompts until reconciled, then a late callback is matched", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    daraja.stk = () => "timeout";
    const first = await pay(booking);
    const p = await payment(first.paymentId);
    expect(p.status).toBe("created"); // outcome unknown — not failed, not pending
    expect(p.providerReference).toBeNull();

    daraja.stk = defaultStkReply;
    const second = await pay(booking);
    expect(second.paymentId).toBe(first.paymentId);
    expect(calls(STK)).toHaveLength(1); // no blind second charge

    // After the uncertain window the attempt is flagged for review and retries unblock.
    await db.update(paymentTransactions).set({ createdAt: new Date(Date.now() - 3 * 60_000), nextStatusCheckAt: new Date(Date.now() - 1000) });
    expect(await reconcileMpesaPayments()).toBe(1);
    expect((await payment(first.paymentId)).status).toBe("reconciliation_required");

    // The prompt did reach the phone and the customer paid: Safaricom's callback is matched by phone + amount.
    daraja.results.set("ws_CO_ORPHAN1", "0");
    await deliver(callbackBody({ providerReference: "ws_CO_ORPHAN1", merchantRequestId: "mr-orphan", amountMinor: p.amountMinor }, 0));
    expect(await lastEventOutcome()).toBe("booking_confirmed");
    expect((await reload(booking.id)).status).toBe("confirmed");
    expect((await payment(first.paymentId)).providerReference).toBe("ws_CO_ORPHAN1");
  });
});

describe("M-Pesa callbacks", () => {
  async function pendingPayment(qty = 2) {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, qty]]);
    const { paymentId } = await pay(booking);
    return { booking, p: await payment(paymentId), tt, event };
  }

  it("7. confirms a verified successful payment: tickets, ledger, email with PDF", async () => {
    const { booking, p } = await pendingPayment(2);
    daraja.results.set(p.providerReference!, "0");
    const res = await deliver(callbackBody(p, 0, { receipt: "TKA1B2C3D4" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    expect(calls(QUERY)).toHaveLength(1); // verified with a status query before confirming

    const b = await reload(booking.id);
    expect(b).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    expect(await payment(p.id)).toMatchObject({ status: "succeeded", providerReceipt: "TKA1B2C3D4", providerResultCode: "0" });
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(2);
    expect(await db.$count(ledgerEntries, eq(ledgerEntries.bookingId, booking.id))).toBe(2);
    expect(customerEmails()).toHaveLength(1);
    expect(customerEmails()[0].attachments?.[0].contentType).toBe("application/pdf");

    // Stored callback is redacted: masked phone, no balance.
    const [ev] = await db.select().from(paymentEvents).where(eq(paymentEvents.kind, "callback"));
    expect(JSON.stringify(ev.payload)).not.toContain("254712345678");
    expect(ev.payload).not.toHaveProperty("Balance");
  });

  it("8 + 17. duplicate callbacks and replays never duplicate tickets, ledger, emails or commission", async () => {
    const { booking, p } = await pendingPayment(3);
    daraja.results.set(p.providerReference!, "0");
    const body = callbackBody(p, 0, { receipt: "TKDUP12345" });
    await deliver(body);
    const dup = await deliver(body);
    expect(dup.body).toMatchObject({ ResultCode: 0, duplicate: true });
    // Same result arriving via reconciliation and a re-run of the stored event.
    expect(await checkMpesaPaymentStatus(p.id, { manual: true })).toBe("already_succeeded");
    const [ev] = await db.select().from(paymentEvents).where(eq(paymentEvents.kind, "callback"));
    expect(await processMpesaCallbackEvent(ev.id, { isLast: false })).toBe("already_processed");
    await Promise.all([deliver(callbackBody(p, 0, { receipt: "TKDUP12345" })), checkMpesaPaymentStatus(p.id, { manual: true })]);
    await processDueJobs();

    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(3);
    expect(await db.$count(ledgerEntries, eq(ledgerEntries.bookingId, booking.id))).toBe(2);
    expect(await db.$count(ledgerEntries, and(eq(ledgerEntries.bookingId, booking.id), eq(ledgerEntries.type, "platform_commission")))).toBe(1);
    expect(await db.$count(emailDeliveries, and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")))).toBe(1);
    expect(customerEmails()).toHaveLength(1);
    expect(await db.$count(auditLogs, eq(auditLogs.action, "booking.confirmed"))).toBe(1);
  });

  it("5. customer cancellation releases nothing early and issues no tickets", async () => {
    const { booking, p } = await pendingPayment();
    daraja.results.set(p.providerReference!, "1032");
    await deliver(callbackBody(p, 1032));
    expect(await payment(p.id)).toMatchObject({ status: "cancelled", providerResultCode: "1032" });
    const b = await reload(booking.id);
    expect(b).toMatchObject({ status: "pending", paymentStatus: "failed" });
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);
    // The customer can start a fresh attempt.
    const retry = await pay(b);
    expect(retry.paymentId).not.toBe(p.id);
    expect(calls(STK)).toHaveLength(2);
  });

  it("6. a failed payment (insufficient balance) is recorded with a helpful message", async () => {
    const { booking, p } = await pendingPayment();
    daraja.results.set(p.providerReference!, "1");
    const body = JSON.stringify({ Body: { stkCallback: { MerchantRequestID: p.merchantRequestId, CheckoutRequestID: p.providerReference, ResultCode: 1, ResultDesc: "The balance is insufficient for the transaction." } } });
    await deliver(body);
    const after = await payment(p.id);
    expect(after.status).toBe("failed");
    expect(after.failureReason).toMatch(/balance was not enough/);
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);
  });

  it("9. an unknown CheckoutRequestID changes nothing and is surfaced to admins", async () => {
    const { booking, p } = await pendingPayment();
    daraja.results.set("ws_CO_UNKNOWN", "0");
    await deliver(callbackBody({ providerReference: "ws_CO_UNKNOWN", merchantRequestId: "mr-x", amountMinor: 99_900 }, 0, { phone: "254799000000" }));
    expect(await lastEventOutcome()).toBe("unknown_checkout_request_paid");
    expect((await payment(p.id)).status).toBe("pending");
    expect((await reload(booking.id)).status).toBe("pending");
    expect(await db.$count(auditLogs, eq(auditLogs.action, "payment.unmatched_mpesa_success"))).toBe(1);
  });

  it("10. an amount mismatch is flagged for reconciliation, never confirmed", async () => {
    const { booking, p } = await pendingPayment();
    daraja.results.set(p.providerReference!, "0");
    await deliver(callbackBody(p, 0, { amountKes: 1 }));
    expect(await lastEventOutcome()).toBe("amount_mismatch_flagged");
    expect((await payment(p.id)).status).toBe("reconciliation_required");
    expect((await reload(booking.id)).status).toBe("pending");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);
  });

  it("rejects callbacks with a wrong URL token, and trusts the status query over a contradicting callback", async () => {
    const { booking, p } = await pendingPayment();
    const forged = await deliver(callbackBody(p, 0), "wrong-token-0000000000000000000");
    expect(forged.status).toBe(404);
    expect((await payment(p.id)).status).toBe("pending");

    // Correct token but M-Pesa says the customer cancelled: the forged "success" loses.
    daraja.results.set(p.providerReference!, "1032");
    await deliver(callbackBody(p, 0));
    expect(await lastEventOutcome()).toBe("payment_cancelled:contradicted_by_query");
    expect((await reload(booking.id)).status).toBe("pending");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(0);
  });

  it("12. a status-query timeout during verification retries, then flags instead of guessing", async () => {
    const { booking, p } = await pendingPayment();
    daraja.query = () => "timeout";
    const res = await deliver(callbackBody(p, 0));
    expect(res.status).toBe(200); // Safaricom is acknowledged promptly regardless
    expect((await payment(p.id)).status).toBe("pending");
    const [job] = await db.select().from(jobs).where(eq(jobs.type, "payment.mpesa_callback"));
    expect(job.status).toBe("pending");
    expect(job.lastError).toMatch(/not yet verifiable/);

    // Exhaust retries → reconciliation_required (booking untouched, no tickets).
    for (let i = 0; i < 5; i++) {
      await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.type, "payment.mpesa_callback"));
      await processDueJobs();
    }
    expect(await lastEventOutcome()).toBe("unverified_flagged");
    expect((await payment(p.id)).status).toBe("reconciliation_required");
    expect((await reload(booking.id)).status).toBe("pending");

    // An admin checks the M-Pesa statement and confirms with the receipt.
    const admin = await makeUser("admin");
    expect(await resolveMpesaPayment({ paymentId: p.id, resolution: "paid", receipt: "TKADMIN123", actorUserId: admin.id })).toBe("booking_confirmed");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(2);
  });
});

describe("M-Pesa reconciliation", () => {
  it("11. a missing callback is reconciled by bounded status queries", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const { paymentId } = await pay(booking);
    let p = await payment(paymentId);
    expect(p.nextStatusCheckAt!.getTime()).toBeGreaterThan(Date.now() + 60_000); // gives the callback time first

    expect(await reconcileMpesaPayments()).toBe(0); // not due yet — no polling storm
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await reconcileMpesaPayments(later)).toBe(1);
    p = await payment(paymentId);
    expect(p).toMatchObject({ status: "pending", statusCheckAttempts: 1 });
    expect(p.nextStatusCheckAt!.getTime()).toBeGreaterThan(Date.now()); // backed off

    daraja.results.set(p.providerReference!, "0");
    await db.update(paymentTransactions).set({ nextStatusCheckAt: new Date(Date.now() - 1000) });
    await reconcileMpesaPayments();
    await processDueJobs();
    expect((await reload(booking.id)).status).toBe("confirmed");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(1);
    expect(customerEmails()).toHaveLength(1);

    // The delayed callback arrives later and only adds the receipt.
    await deliver(callbackBody(p, 0, { receipt: "TKLATE1234" }));
    expect(await lastEventOutcome()).toBe("already_succeeded");
    expect((await payment(paymentId)).providerReceipt).toBe("TKLATE1234");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(1);
  });

  it("12b. status queries that keep timing out end in reconciliation_required", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const { paymentId } = await pay(booking);
    daraja.query = () => "timeout";
    for (let i = 0; i < MAX_STATUS_CHECKS; i++) {
      await db.update(paymentTransactions).set({ nextStatusCheckAt: new Date(Date.now() - 1000) });
      await reconcileMpesaPayments();
    }
    const p = await payment(paymentId);
    expect(p).toMatchObject({ status: "reconciliation_required", statusCheckAttempts: MAX_STATUS_CHECKS, nextStatusCheckAt: null });
    expect(await reconcileMpesaPayments(new Date(Date.now() + 86_400_000))).toBe(0); // no further automatic queries
    expect(await db.$count(paymentEvents, eq(paymentEvents.kind, "status_query"))).toBe(MAX_STATUS_CHECKS);
    expect((await reload(booking.id)).status).toBe("pending");
  });

  it("14. late success after the hold expired: confirmed if tickets remain, otherwise flagged for manual refund", async () => {
    const { event, tt } = await setup(1);
    const late = await checkout(event.id, [[tt.id, 1]]);
    const { paymentId } = await pay(late);
    const p = await payment(paymentId);

    // Hold lapses; someone else buys the last ticket.
    await db.update(bookings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(bookings.id, late.id));
    await expireStaleBookings();
    expect((await reload(late.id)).status).toBe("expired");
    const other = await checkout(event.id, [[tt.id, 1]]);
    await db.transaction(async (tx) => confirmBooking(tx, (await lockBooking(tx, other.id))!, { free: false }));

    daraja.results.set(p.providerReference!, "0");
    await deliver(callbackBody(p, 0, { receipt: "TKLATE5678" }));
    expect(await lastEventOutcome()).toBe("late_payment_sold_out_refunded");
    const b = await reload(late.id);
    expect(b).toMatchObject({ status: "failed", paymentStatus: "refund_pending" });
    expect(await db.$count(tickets, eq(tickets.bookingId, late.id))).toBe(0);
    const [refund] = await db.select().from(refunds).where(eq(refunds.bookingId, late.id));
    expect(refund.status).toBe("manual_required"); // M-Pesa Express has no automatic refund
    const [t] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, tt.id));
    expect(t.sold).toBe(1); // never oversold

    // Admin reverses it in the M-Pesa org portal and records the reversal.
    await completeRefund(refund.id, paymentId, "RVSL123456", (await makeUser("admin")).id);
    expect(await reload(late.id)).toMatchObject({ paymentStatus: "refunded" });
    expect((await payment(paymentId)).status).toBe("refunded");
  });

  it("14b. late success with tickets still available confirms the booking", async () => {
    const { event, tt } = await setup(5);
    const late = await checkout(event.id, [[tt.id, 1]]);
    const { paymentId } = await pay(late);
    await db.update(bookings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(bookings.id, late.id));
    await expireStaleBookings();
    const p = await payment(paymentId);
    daraja.results.set(p.providerReference!, "0");
    await deliver(callbackBody(p, 0));
    expect(await lastEventOutcome()).toBe("late_payment_confirmed");
    expect(await db.$count(tickets, eq(tickets.bookingId, late.id))).toBe(1);
  });
});

describe("after a verified M-Pesa payment", () => {
  it("15. a PDF generation failure keeps the paid booking and retries the email without recharging", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const { paymentId } = await pay(booking);
    const p = await payment(paymentId);
    daraja.results.set(p.providerReference!, "0");
    pdf.fail = true;
    await deliver(callbackBody(p, 0));

    expect((await reload(booking.id)).status).toBe("confirmed");
    let [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d).toMatchObject({ status: "retry_pending" });
    expect(d.lastError).toMatch(/PDF generation failed/);
    expect(calls(STK)).toHaveLength(1);

    pdf.fail = false;
    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.type, "email.send"));
    await processDueJobs();
    [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("captured");
    expect(customerEmails()).toHaveLength(1);
    expect(calls(STK)).toHaveLength(1);
    expect((await payment(paymentId)).status).toBe("succeeded");
  });

  it("16. an email delivery failure keeps the paid booking and retries safely", async () => {
    const { event, tt } = await setup();
    const booking = await checkout(event.id, [[tt.id, 2]]);
    const { paymentId } = await pay(booking);
    const p = await payment(paymentId);
    daraja.results.set(p.providerReference!, "0");
    setEmailTransportOverride(failingTransport);
    await deliver(callbackBody(p, 0));

    expect((await reload(booking.id)).status).toBe("confirmed");
    let [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("retry_pending");
    expect(d.lastError).toMatch(/SMTP/);

    setEmailTransportOverride(memoryTransport);
    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.type, "email.send"));
    await processDueJobs();
    [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("captured");
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(2);
    expect(calls(STK)).toHaveLength(1);
  });

  it("free bookings never touch Daraja", async () => {
    const { event, tt } = await setup(10, 0);
    const booking = await checkout(event.id, [[tt.id, 1]]);
    expect(booking.status).toBe("confirmed");
    expect(daraja.calls).toHaveLength(0);
  });
});

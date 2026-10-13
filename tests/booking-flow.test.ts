import { and, eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { bookings, emailDeliveries, jobs, ledgerEntries, paymentEvents, refunds, tickets, ticketTypes } from "@/db/schema";
import { expireStaleBookings } from "@/server/bookings/lifecycle";
import { processDueJobs } from "@/server/jobs/queue";
import { beginPayment, buyTickets, checkout, makeEvent, makeOrganizer, resetDb, sendCallback } from "./helpers";

async function reload(id: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id));
  return b;
}
async function inventory(id: string) {
  const [t] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, id));
  return t;
}

describe("checkout & inventory", () => {
  beforeEach(resetDb);

  it("never oversells under concurrent purchases of the last tickets", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: 1000, capacity: 5 }]);
    const attempts = await Promise.allSettled(Array.from({ length: 25 }, () => checkout(event.id, [[tt.id, 1]])));
    const ok = attempts.filter((a) => a.status === "fulfilled");
    const rejected = attempts.filter((a) => a.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(5);
    expect(rejected).toHaveLength(20);
    expect(rejected.every((r) => /sold out|left/.test(String(r.reason?.message)))).toBe(true);
    const inv = await inventory(tt.id);
    expect(inv.reserved + inv.sold).toBe(5);
  });

  it("handles mixed-quantity races exactly at capacity", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: 500, capacity: 10 }]);
    const qtys = [3, 3, 3, 3, 2, 2, 4, 1];
    const results = await Promise.allSettled(qtys.map((q) => checkout(event.id, [[tt.id, q]])));
    const held = results.reduce((s, r, i) => s + (r.status === "fulfilled" ? qtys[i] : 0), 0);
    expect(held).toBeLessThanOrEqual(10);
    const inv = await inventory(tt.id);
    expect(inv.reserved).toBe(held);
  });

  it("returns the same booking for a repeated checkout submission (idempotency)", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const [a, b] = await Promise.all([checkout(event.id, [[tt.id, 2]], { key: "same-key-123456789" }), checkout(event.id, [[tt.id, 2]], { key: "same-key-123456789" })]);
    expect(a.id).toBe(b.id);
    expect((await inventory(tt.id)).reserved).toBe(2);
  });

  it("prices from the database and snapshots commission", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [ga, vip] } = await makeEvent(organizer.id, [
      { name: "GA", priceKes: 2500, capacity: 10 },
      { name: "VIP", priceKes: 6000, capacity: 10 },
    ]);
    const b = await checkout(event.id, [[ga.id, 2], [vip.id, 1]]);
    expect(b.subtotalMinor).toBe(1_100_000);
    expect(b.totalMinor).toBe(1_100_000);
    expect(b.commissionBps).toBe(500);
    expect(b.commissionMinor).toBe(55_000);
  });

  it("rejects quantity above per-order limit and unpublished events", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: 100, capacity: 100, maxPerOrder: 2 }]);
    await expect(checkout(event.id, [[tt.id, 3]])).rejects.toThrow(/Maximum 2/);
    const pending = await makeOrganizer("pending");
    const { event: e2, ticketTypes: [t2] } = await makeEvent(pending.organizer.id);
    await expect(checkout(e2.id, [[t2.id, 1]])).rejects.toThrow(/not available/);
  });
});

describe("payments", () => {
  beforeEach(resetDb);

  it("confirms only after a verified callback and issues one ticket per unit", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [ga, vip] } = await makeEvent(organizer.id, [
      { name: "GA", priceKes: 1000, capacity: 10 },
      { name: "VIP", priceKes: 3000, capacity: 10 },
    ]);
    const booking = await checkout(event.id, [[ga.id, 2], [vip.id, 1]]);
    const p = await beginPayment(booking);
    // A browser returning from the provider does nothing by itself:
    expect((await reload(booking.id)).status).toBe("pending");

    const res = await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
    expect(res).toEqual({ status: 200, outcome: "booking_confirmed" });
    const b = await reload(booking.id);
    expect(b.status).toBe("confirmed");
    expect(b.paymentStatus).toBe("paid");
    const tix = await db.select().from(tickets).where(eq(tickets.bookingId, booking.id));
    expect(tix).toHaveLength(3);
    expect(new Set(tix.map((t) => t.code)).size).toBe(3);
    expect((await inventory(ga.id)).sold).toBe(2);
    expect((await inventory(ga.id)).reserved).toBe(0);
  });

  it("ignores duplicate callbacks: no duplicate tickets, ledger rows or emails", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const booking = await checkout(event.id, [[tt.id, 2]]);
    const p = await beginPayment(booking);
    const first = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_same" });
    const dup = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_same" });
    const redelivered = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { eventId: "evt_other" });
    expect(first.outcome).toBe("booking_confirmed");
    expect(dup.outcome).toBe("duplicate_ignored");
    expect(redelivered.outcome).toBe("already_succeeded");
    // Concurrent duplicate deliveries
    await Promise.all(Array.from({ length: 5 }, () => sendCallback(p.providerReference!, "succeeded", p.amountMinor)));
    expect(await db.$count(tickets, eq(tickets.bookingId, booking.id))).toBe(2);
    expect(await db.$count(ledgerEntries, eq(ledgerEntries.bookingId, booking.id))).toBe(2);
    expect(await db.$count(emailDeliveries, and(eq(emailDeliveries.bookingId, booking.id), eq(emailDeliveries.kind, "booking_confirmation")))).toBe(1);
    expect((await inventory(tt.id)).sold).toBe(2);
  });

  it("rejects forged callbacks and flags amount mismatches", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const p = await beginPayment(booking);
    const forged = await sendCallback(p.providerReference!, "succeeded", p.amountMinor, { signature: "forged" });
    expect(forged.status).toBe(401);
    const tampered = await sendCallback(p.providerReference!, "succeeded", 100);
    expect(tampered.outcome).toBe("amount_mismatch_flagged");
    expect((await reload(booking.id)).status).toBe("pending");
    const logged = await db.select().from(paymentEvents);
    expect(logged.some((e) => e.signatureValid === false)).toBe(true);
  });

  it("keeps the hold after a failed payment and allows a retry", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const booking = await checkout(event.id, [[tt.id, 1]]);
    const p1 = await beginPayment(booking);
    expect((await sendCallback(p1.providerReference!, "failed", p1.amountMinor)).outcome).toBe("payment_failed");
    let b = await reload(booking.id);
    expect(b.status).toBe("pending");
    expect(b.paymentStatus).toBe("failed");
    // A late failure must never undo a success:
    const p2 = await beginPayment(b);
    await sendCallback(p2.providerReference!, "succeeded", p2.amountMinor);
    await sendCallback(p2.providerReference!, "failed", p2.amountMinor);
    b = await reload(booking.id);
    expect(b.status).toBe("confirmed");
  });

  it("releases expired holds and honours a delayed payment if stock remains", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: 1000, capacity: 3 }]);
    const booking = await checkout(event.id, [[tt.id, 2]]);
    const p = await beginPayment(booking);
    await db.update(bookings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(bookings.id, booking.id));
    expect(await expireStaleBookings()).toBe(1);
    expect((await reload(booking.id)).status).toBe("expired");
    expect((await inventory(tt.id)).reserved).toBe(0);

    const res = await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
    expect(res.outcome).toBe("late_payment_confirmed");
    expect((await reload(booking.id)).status).toBe("confirmed");
    expect((await inventory(tt.id)).sold).toBe(2);
  });

  it("auto-refunds a delayed payment when the tickets were resold", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: 1000, capacity: 2 }]);
    const slow = await checkout(event.id, [[tt.id, 2]]);
    const p = await beginPayment(slow);
    await db.update(bookings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(bookings.id, slow.id));
    await expireStaleBookings();
    await buyTickets(event.id, [[tt.id, 2]]); // someone else buys the released stock

    const res = await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
    expect(res.outcome).toBe("late_payment_sold_out_refunded");
    const b = await reload(slow.id);
    expect(b.status).toBe("failed");
    expect(b.paymentStatus).toBe("refund_pending");
    expect(await db.$count(tickets, eq(tickets.bookingId, slow.id))).toBe(0);
    const inv = await inventory(tt.id);
    expect(inv.sold).toBe(2);

    await processDueJobs(20);
    const [r] = await db.select().from(refunds).where(eq(refunds.bookingId, slow.id));
    expect(r.status).toBe("succeeded");
    expect((await reload(slow.id)).paymentStatus).toBe("refunded");
  });

  it("confirms free bookings immediately without a payment", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "Free", priceKes: 0, capacity: 10 }]);
    const b = await checkout(event.id, [[tt.id, 2]]);
    expect(b.status).toBe("confirmed");
    expect(b.paymentStatus).toBe("not_required");
    expect(await db.$count(tickets, eq(tickets.bookingId, b.id))).toBe(2);
    expect(await db.$count(ledgerEntries, eq(ledgerEntries.bookingId, b.id))).toBe(0);
    // Buyer's tickets + the organizer's "new booking" notice.
    expect(await db.$count(jobs, sql`${jobs.type} = 'email.send'`)).toBe(2);
  });
});

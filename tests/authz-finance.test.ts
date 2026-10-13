import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { bookings, emailDeliveries, events, tickets, users } from "@/db/schema";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import { canPublish, requireOwnedEvent } from "@/server/auth/guards";
import { createBookingAccessToken } from "@/server/bookings/access";
import { canAccessBooking } from "@/server/bookings/queries";
import { cancelEvent, refundBooking } from "@/server/bookings/refunds";
import { publishEvent } from "@/server/events/mutations";
import { financialSummary } from "@/server/ledger";
import { setOrganizerVerification } from "@/server/organizers/service";
import { attendeesForEvent, recentBookings } from "@/server/organizers/reports";
import { processDueJobs } from "@/server/jobs/queue";
import { buyTickets, makeEvent, makeOrganizer, makeUser, resetDb } from "./helpers";

describe("authorization", () => {
  beforeEach(resetDb);

  it("customers cannot access another customer's booking", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const alice = await makeUser();
    const bob = await makeUser();
    const admin = await makeUser("admin");
    const b = await buyTickets(event.id, [[tt.id, 1]], { userId: alice.id });
    const other = await buyTickets(event.id, [[tt.id, 1]], { userId: bob.id });

    expect(canAccessBooking(b, alice)).toBe(true);
    expect(canAccessBooking(b, bob)).toBe(false);
    expect(canAccessBooking(b, null)).toBe(false); // reference alone is never enough
    expect(canAccessBooking(b, admin)).toBe(true);
    // A valid link for Bob's booking doesn't open Alice's.
    expect(canAccessBooking(b, bob, createBookingAccessToken(other.id, event.endsAt))).toBe(false);
    // Guest link for this booking works without an account.
    expect(canAccessBooking(b, null, createBookingAccessToken(b.id, event.endsAt))).toBe(true);
  });

  it("organizers cannot load or report on another organizer's events", async () => {
    const a = await makeOrganizer();
    const b = await makeOrganizer();
    const { event: evA, ticketTypes: [tt] } = await makeEvent(a.organizer.id);
    await buyTickets(evA.id, [[tt.id, 1]]);

    await expect(requireOwnedEvent(evA.id, b)).rejects.toThrow(/not found/i);
    await expect(requireOwnedEvent(evA.id, a)).resolves.toMatchObject({ id: evA.id });
    // Reports are scoped by the caller's own event ids.
    const bEvents = (await db.select({ id: events.id }).from(events).where(eq(events.organizerId, b.organizer.id))).map((e) => e.id);
    expect(await recentBookings({ eventIds: bEvents })).toHaveLength(0);
    expect((await financialSummary({ organizerId: b.organizer.id })).grossSalesMinor).toBe(0);
    expect(await attendeesForEvent(evA.id)).toHaveLength(1);
  });

  it("unverified organizers can't publish; verification grants the role", async () => {
    const { user, organizer } = await makeOrganizer("pending");
    const { event } = await makeEvent(organizer.id);
    await db.update(events).set({ status: "draft" }).where(eq(events.id, event.id));
    expect(canPublish(user, organizer)).toBe(false);
    await expect(publishEvent(event, { user, organizer })).rejects.toThrow(/verified/);

    const admin = await makeUser("admin");
    await setOrganizerVerification(organizer.id, "verified", admin, "KYC checked");
    const [u2] = await db.select().from(users).where(eq(users.id, user.id));
    expect(u2.role).toBe("organizer");
    await publishEvent(event, { user: u2, organizer: { ...organizer, verificationStatus: "verified" } });
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].status).toBe("published");
  });
});

describe("refunds, cancellation & commission", () => {
  beforeEach(resetDb);

  it("keeps commission and proceeds consistent through refunds", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "GA", priceKes: 2500, capacity: 100 }]);
    const b1 = await buyTickets(event.id, [[tt.id, 2]]); // 5,000
    await buyTickets(event.id, [[tt.id, 1]]); // 2,500

    let s = await financialSummary({ organizerId: organizer.id });
    expect(s.grossSalesMinor).toBe(750_000);
    expect(s.commissionMinor).toBe(37_500);
    expect(s.estimatedProceedsMinor).toBe(712_500);

    await db.transaction((tx) => refundBooking(tx, { bookingId: b1.id, actorUserId: user.id, reason: "Customer request", returnInventory: true }));
    s = await financialSummary({ organizerId: organizer.id });
    expect(s.refundsMinor).toBe(500_000);
    expect(s.commissionReversedMinor).toBe(25_000);
    expect(s.netCommissionMinor).toBe(12_500);
    expect(s.estimatedProceedsMinor).toBe(237_500); // 2,500 − 125
    expect(s.estimatedProceedsMinor).toBe(s.grossSalesMinor - s.commissionMinor - s.refundsMinor + s.commissionReversedMinor);

    await processDueJobs(20);
    const [b] = await db.select().from(bookings).where(eq(bookings.id, b1.id));
    expect(b.status).toBe("refunded");
    expect(b.paymentStatus).toBe("refunded");
    // refunding twice is rejected
    await expect(
      db.transaction((tx) => refundBooking(tx, { bookingId: b1.id, actorUserId: user.id, reason: "again", returnInventory: true })),
    ).rejects.toThrow(/Only confirmed/);
  });

  it("cancelling an event refunds every booking and invalidates tickets", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const b1 = await buyTickets(event.id, [[tt.id, 2]]);
    const b2 = await buyTickets(event.id, [[tt.id, 1]]);
    const res = await cancelEvent({ eventId: event.id, actorUserId: user.id, reason: "Venue unavailable" });
    expect(res.refunded).toBe(2);
    for (const id of [b1.id, b2.id]) {
      const tix = await db.select().from(tickets).where(eq(tickets.bookingId, id));
      expect(tix.every((t) => t.status === "refunded")).toBe(true);
    }
    const notices = await db.select().from(emailDeliveries).where(eq(emailDeliveries.kind, "event_cancelled"));
    expect(notices).toHaveLength(2);
    const s = await financialSummary({ eventIds: [event.id] });
    expect(s.estimatedProceedsMinor).toBe(0);
    expect(s.netCommissionMinor).toBe(0);
  });
});

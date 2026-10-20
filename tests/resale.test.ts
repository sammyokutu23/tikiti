import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { bookings, events, ledgerEntries, refunds, resaleListings, resalePayouts, tickets, ticketTypes } from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { refundBooking } from "@/server/bookings/refunds";
import { processDueJobs } from "@/server/jobs/queue";
import { createResaleCheckout } from "@/server/resale/checkout";
import { approveExternalListing, cancelListing, closeEndedListings, correctExternalListingDetails, createExternalListing, createPlatformListing, marketplaceListings, rejectExternalListing, withdrawnDetails } from "@/server/resale/listings";
import { scanTicket, setTicketReaderOverride } from "@/server/resale/scan";
import { disputeResale, markPayoutPaid, refundDisputedResale } from "@/server/resale/payouts";
import { resaleFeeMinor } from "@/server/resale/policy";
import { reconcileOrganizer, financialSummary } from "@/server/ledger";
import { beginPayment, buyTickets, makeEvent, makeOrganizer, makeUser, resetDb, sendCallback, sentEmails } from "./helpers";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);

async function sellerWithTicket(priceKes = 1000) {
  const { organizer } = await makeOrganizer();
  const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, [{ name: "Regular", priceKes, capacity: 50 }]);
  const seller = await makeUser();
  const booking = await buyTickets(event.id, [[tt.id, 1]], { userId: seller.id, email: seller.email });
  const [ticket] = await db.select().from(tickets).where(eq(tickets.bookingId, booking.id));
  return { organizer, event, tt, seller, booking, ticket };
}

function buy(listingId: string, opts: { userId?: string | null; key?: string } = {}) {
  return createResaleCheckout(
    { listingId, buyerName: "Brian Otieno", buyerEmail: "brian@example.com", buyerPhone: "254722000111", idempotencyKey: opts.key ?? `rk-${randomToken(12)}` },
    opts.userId ?? null,
  );
}

async function pay(bookingId: string) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  const p = await beginPayment(b);
  await sendCallback(p.providerReference!, "succeeded", p.amountMinor);
  const [after] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  return after;
}

describe("resale pricing", () => {
  it("charges the buyer a 10% fee rounded up to a whole shilling", () => {
    expect(resaleFeeMinor(100_000)).toBe(10_000);
    expect(resaleFeeMinor(125_500 - 500)).toBe(12_500);
    expect(resaleFeeMinor(5_500)).toBe(600); // 55 KES → fee 5.5 → 6 KES
  });
});

describe("TikoSoko ticket resale", () => {
  beforeEach(resetDb);

  it("reissues the ticket to the buyer, revokes the seller's QR and holds the payout", async () => {
    const { seller, ticket, event, organizer, tt } = await sellerWithTicket(1000);
    const listing = await createPlatformListing({ ticketId: ticket.id, priceKes: 1500, payoutPhone: "254711000222" }, seller.id);
    expect(listing.status).toBe("active");
    expect((await marketplaceListings()).map((r) => r.listing.id)).toEqual([listing.id]);

    const booking = await buy(listing.id);
    expect(booking.subtotalMinor).toBe(150_000);
    expect(booking.feesMinor).toBe(15_000);
    expect(booking.totalMinor).toBe(165_000);
    expect(booking.commissionMinor).toBe(0);

    const confirmed = await pay(booking.id);
    expect(confirmed.status).toBe("confirmed");

    const [old] = await db.select().from(tickets).where(eq(tickets.id, ticket.id));
    expect(old.status).toBe("revoked");
    const fresh = await db.select().from(tickets).where(eq(tickets.bookingId, booking.id));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].status).toBe("valid");
    expect(fresh[0].code).not.toBe(ticket.code);
    expect(fresh[0].attendeeName).toBe("Brian Otieno");

    const [l] = await db.select().from(resaleListings).where(eq(resaleListings.id, listing.id));
    expect(l.status).toBe("sold");
    const [p] = await db.select().from(resalePayouts).where(eq(resalePayouts.listingId, listing.id));
    expect(p.status).toBe("held");
    expect(p.amountMinor).toBe(150_000);
    expect(p.releaseAt.getTime()).toBe(event.endsAt.getTime() + 24 * 3600_000);

    // No double counting for the organizer: inventory, ledger and reconciliation unchanged.
    const [inv] = await db.select().from(ticketTypes).where(eq(ticketTypes.id, tt.id));
    expect(inv.sold).toBe(1);
    const fin = await financialSummary({ organizerId: organizer.id });
    expect(fin.grossSalesMinor).toBe(100_000);
    expect((await reconcileOrganizer(organizer.id)).grossMinor).toBe(100_000);
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, booking.id))).toHaveLength(0);

    await processDueJobs(20);
    const kinds = sentEmails.map((m) => m.tags?.kind);
    expect(kinds).toContain("booking_confirmation");
    expect(kinds).toContain("resale_sold");
  });

  it("only lets one buyer check out at a time and never sells twice", async () => {
    const { seller, ticket } = await sellerWithTicket();
    const listing = await createPlatformListing({ ticketId: ticket.id, priceKes: 1200, payoutPhone: "254711000222" }, seller.id);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => buy(listing.id)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("refunds a late payment when the ticket was used meanwhile", async () => {
    const { seller, ticket } = await sellerWithTicket();
    const listing = await createPlatformListing({ ticketId: ticket.id, priceKes: 1200, payoutPhone: "254711000222" }, seller.id);
    const booking = await buy(listing.id);
    await db.update(tickets).set({ status: "checked_in", checkedInAt: new Date() }).where(eq(tickets.id, ticket.id));
    const after = await pay(booking.id);
    expect(after.status).toBe("failed");
    expect(after.paymentStatus).toBe("refund_pending");
    expect(await db.select().from(refunds).where(eq(refunds.bookingId, booking.id))).toHaveLength(1);
    expect(await db.select().from(resalePayouts)).toHaveLength(0);
  });

  it("rejects listing someone else's ticket, buying your own, and listing twice", async () => {
    const { seller, ticket } = await sellerWithTicket();
    const stranger = await makeUser();
    await expect(createPlatformListing({ ticketId: ticket.id, priceKes: 1000, payoutPhone: "254711000222" }, stranger.id)).rejects.toThrow(/not found/);
    const listing = await createPlatformListing({ ticketId: ticket.id, priceKes: 1000, payoutPhone: "254711000222" }, seller.id);
    await expect(createPlatformListing({ ticketId: ticket.id, priceKes: 900, payoutPhone: "254711000222" }, seller.id)).rejects.toThrow(/already listed/);
    await expect(buy(listing.id, { userId: seller.id })).rejects.toThrow(/own listing/);
  });

  it("closes listings whose ticket was used or whose event ended", async () => {
    const a = await sellerWithTicket();
    const b = await sellerWithTicket();
    const la = await createPlatformListing({ ticketId: a.ticket.id, priceKes: 1000, payoutPhone: "254711000222" }, a.seller.id);
    const lb = await createPlatformListing({ ticketId: b.ticket.id, priceKes: 1000, payoutPhone: "254711000222" }, b.seller.id);
    await db.update(tickets).set({ status: "checked_in" }).where(eq(tickets.id, a.ticket.id));
    await db.update(events).set({ startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 3600_000) }).where(eq(events.id, b.event.id));
    expect(await closeEndedListings()).toBe(2);
    const rows = await db.select().from(resaleListings);
    expect(rows.map((r) => r.status).sort()).toEqual(["closed", "closed"]);
    expect([la.id, lb.id].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("blocks withdrawing while a buyer is paying", async () => {
    const { seller, ticket } = await sellerWithTicket();
    const listing = await createPlatformListing({ ticketId: ticket.id, priceKes: 1000, payoutPhone: "254711000222" }, seller.id);
    await buy(listing.id);
    await expect(cancelListing(listing.id, seller)).rejects.toThrow(/paying/);
  });

  it("cancels the seller payout when the resale booking is refunded", async () => {
    const { seller, ticket } = await sellerWithTicket();
    const admin = await makeUser("admin");
    const listing = await createPlatformListing({ ticketId: ticket.id, priceKes: 1000, payoutPhone: "254711000222" }, seller.id);
    const booking = await pay((await buy(listing.id)).id);
    await db.transaction((tx) => refundBooking(tx, { bookingId: booking.id, actorUserId: admin.id, reason: "test", returnInventory: false }));
    const [p] = await db.select().from(resalePayouts).where(eq(resalePayouts.bookingId, booking.id));
    expect(p.status).toBe("cancelled");
    expect(await db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, booking.id))).toHaveLength(0);
  });
});

describe("outside ticket resale", () => {
  beforeEach(resetDb);

  async function submit(seller: { id: string }) {
    return createExternalListing(
      {
        eventName: "Blankets & Wine",
        venue: "Ngong Racecourse",
        city: "Nairobi",
        startsAtLocal: new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 16),
        ticketTypeName: "Early bird",
        platform: "Mookh",
        orderRef: "MK-123",
        note: "",
        priceKes: 3000,
        payoutPhone: "254711000222",
      },
      { ticket: { filename: "ticket.png", contentType: "image/png", data: png }, proof: { filename: "receipt.png", contentType: "image/png", data: png } },
      seller.id,
    );
  }

  it("stays hidden until an admin approves it, then sells with a 72h escrow", async () => {
    const seller = await makeUser();
    const admin = await makeUser("admin");
    const listing = await submit(seller);
    expect(listing.status).toBe("pending_review");
    expect(await marketplaceListings()).toHaveLength(0);
    await expect(buy(listing.id)).rejects.toThrow(/no longer for sale/);

    const start = new Date(Date.now() + 10 * 86_400_000);
    await approveExternalListing(
      listing.id,
      { mode: "create", title: "Blankets & Wine", venue: "Ngong Racecourse", city: "Nairobi", category: "festival", startsAtLocal: start.toISOString().slice(0, 16), endsAtLocal: new Date(start.getTime() + 8 * 3600_000).toISOString().slice(0, 16) },
      admin.id,
    );
    const [approved] = await db.select().from(resaleListings).where(eq(resaleListings.id, listing.id));
    expect(approved.status).toBe("active");
    const [ev] = await db.select().from(events).where(eq(events.id, approved.eventId!));
    expect(ev.isExternal).toBe(true);
    expect(ev.isHidden).toBe(true);
    expect(await marketplaceListings()).toHaveLength(1);

    const booking = await pay((await buy(listing.id)).id);
    expect(booking.status).toBe("confirmed");
    expect(await db.select().from(tickets).where(eq(tickets.bookingId, booking.id))).toHaveLength(0);
    const [p] = await db.select().from(resalePayouts).where(eq(resalePayouts.bookingId, booking.id));
    expect(p.releaseAt.getTime()).toBe(ev.endsAt.getTime() + 72 * 3600_000);

    // Buyer reports it; admin refunds them; the payout is cancelled.
    await disputeResale(booking.id, "The QR code was rejected at the gate.", null);
    const [disputed] = await db.select().from(resalePayouts).where(eq(resalePayouts.id, p.id));
    expect(disputed.status).toBe("disputed");
    await expect(markPayoutPaid(p.id, "SJK3H7QX2P", admin.id)).rejects.toThrow(/held/);
    await refundDisputedResale(p.id, admin.id, "Seller's ticket was invalid");
    const [after] = await db.select().from(resalePayouts).where(eq(resalePayouts.id, p.id));
    expect(after.status).toBe("cancelled");
    const [b] = await db.select().from(bookings).where(eq(bookings.id, booking.id));
    expect(b.status).toBe("refunded");
  });

  it("lets an admin withdraw the submitted details and enter new ones before listing", async () => {
    const seller = await makeUser();
    const admin = await makeUser("admin");
    const listing = await submit(seller);
    const startsAtLocal = new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 16);
    const fixed = { eventName: "Blankets & Wine: November", venue: "Ngong Racecourse", city: "Nairobi", startsAtLocal, ticketTypeName: "VIP", platform: "Mookh", orderRef: "MK-124", note: "" };
    await correctExternalListingDetails(listing.id, fixed, admin.id);

    const [l] = await db.select().from(resaleListings).where(eq(resaleListings.id, listing.id));
    expect(l.externalEventName).toBe("Blankets & Wine: November");
    expect(l.ticketTypeName).toBe("VIP");
    expect(l.priceMinor).toBe(listing.priceMinor); // price and payout stay the seller's
    const history = await withdrawnDetails(listing.id);
    expect(history).toHaveLength(1);
    expect(history[0].details.ticketTypeName).toBe("Early bird");
    expect(history[0].details.orderRef).toBe("MK-123");

    await rejectExternalListing(listing.id, "Receipt doesn't match the ticket", admin.id);
    await expect(correctExternalListingDetails(listing.id, fixed, admin.id)).rejects.toThrow(/waiting for review/);
  });

  it("rejection needs a reason and closes the listing", async () => {
    const seller = await makeUser();
    const admin = await makeUser("admin");
    const listing = await submit(seller);
    await expect(rejectExternalListing(listing.id, "", admin.id)).rejects.toThrow(/why/);
    await rejectExternalListing(listing.id, "Receipt doesn't match the ticket", admin.id);
    const [l] = await db.select().from(resaleListings).where(and(eq(resaleListings.id, listing.id)));
    expect(l.status).toBe("rejected");
  });

  it("only pays out after the escrow window", async () => {
    const seller = await makeUser();
    const admin = await makeUser("admin");
    const listing = await submit(seller);
    const start = new Date(Date.now() + 10 * 86_400_000);
    await approveExternalListing(
      listing.id,
      { mode: "create", title: "B&W", venue: "Ngong", city: "Nairobi", category: "festival", startsAtLocal: start.toISOString().slice(0, 16), endsAtLocal: new Date(start.getTime() + 3600_000).toISOString().slice(0, 16) },
      admin.id,
    );
    const booking = await pay((await buy(listing.id)).id);
    const [p] = await db.select().from(resalePayouts).where(eq(resalePayouts.bookingId, booking.id));
    await expect(markPayoutPaid(p.id, "SJK3H7QX2P", admin.id)).rejects.toThrow(/escrow/);
    await db.update(resalePayouts).set({ releaseAt: new Date(Date.now() - 1000) }).where(eq(resalePayouts.id, p.id));
    await markPayoutPaid(p.id, "sjk3h7qx2p", admin.id);
    const [paid] = await db.select().from(resalePayouts).where(eq(resalePayouts.id, p.id));
    expect(paid.status).toBe("paid");
    expect(paid.payoutReference).toBe("SJK3H7QX2P");
  });
});

describe("scan ticket details", () => {
  afterEach(() => setTicketReaderOverride(null));
  const file = { filename: "ticket.png", contentType: "image/png", data: png };
  const cfg = { apiKey: "sk-test", model: "test-model" };

  it("returns trimmed fields and drops a malformed date", async () => {
    setTicketReaderOverride(async () =>
      JSON.stringify({ eventName: " Sol Fest ", venue: "Uhuru Gardens", city: "Nairobi", startsAtLocal: "next Friday", ticketTypeName: "VIP", platform: "", orderRef: null }),
    );
    expect(await scanTicket(file, cfg)).toEqual({ eventName: "Sol Fest", venue: "Uhuru Gardens", city: "Nairobi", startsAtLocal: null, ticketTypeName: "VIP", platform: null, orderRef: null });
  });

  it("gives the seller a plain message when scanning is off or fails", async () => {
    await expect(scanTicket(file, null)).rejects.toThrow(/fill in the details yourself/);
    setTicketReaderOverride(async () => {
      throw new Error("boom");
    });
    await expect(scanTicket(file, cfg)).rejects.toThrow(/fill in the details yourself/);
    setTicketReaderOverride(async () => JSON.stringify({ eventName: null, venue: null, city: null, startsAtLocal: null, ticketTypeName: null, platform: null, orderRef: null }));
    await expect(scanTicket(file, cfg)).rejects.toThrow(/couldn't find any ticket details/);
  });
});

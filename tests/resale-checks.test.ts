import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, jobs, resaleListings } from "@/db/schema";
import { utcToZonedLocal } from "@/lib/dates";
import { buyCatalog } from "@/server/events/buy";
import { processDueJobs } from "@/server/jobs/queue";
import {
  adminListings,
  approveExternalListing,
  createExternalListing,
  createPlatformListing,
  externalListingSchema,
  listingDocumentHistory,
  listingDocuments,
  replaceListingTicketFile,
} from "@/server/resale/listings";
import { setReceiptReaderOverride, setTicketReaderOverride, type ScannedReceipt, type ScannedTicket } from "@/server/resale/scan";
import { nameSimilarity, verifyExternalListing, type CheckResult } from "@/server/resale/verify";
import { buyTickets, makeEvent, makeOrganizer, makeUser, resetDb } from "./helpers";

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);
const files = { ticket: { filename: "ticket.png", contentType: "image/png", data: png }, proof: { filename: "receipt.png", contentType: "image/png", data: png } };
const start = new Date(Date.now() + 10 * 86_400_000);
const startLocal = utcToZonedLocal(start);

let ticketRead: ScannedTicket;
let receiptRead: ScannedReceipt;

function submit(sellerId: string, over: Record<string, unknown> = {}) {
  const input = externalListingSchema.parse({
    eventName: "Blankets & Wine Nairobi",
    venue: "Ngong Racecourse",
    city: "Nairobi",
    startsAtLocal: startLocal,
    ticketTypeName: "Early bird",
    platform: "Mookh",
    orderRef: "MK-123",
    mpesaCode: "sjk3h7qx2p",
    note: "",
    priceKes: 3000,
    payoutPhone: "0711000222",
    ...over,
  });
  return createExternalListing(input, files, sellerId);
}

const listing = async (id: string) => (await db.select().from(resaleListings).where(eq(resaleListings.id, id)))[0];

beforeEach(async () => {
  await resetDb();
  process.env.OPENAI_API_KEY = "sk-test-0123456789abcdefghijklmnop";
  process.env.OPENAI_SCAN_MODEL = "gpt-test-vision";
  ticketRead = { eventName: "BLANKETS & WINE — Nairobi Edition", venue: "Ngong Racecourse", city: "Nairobi", startsAtLocal: startLocal, ticketTypeName: "Early Bird", platform: "Mookh", orderRef: "MK 123" };
  receiptRead = { mpesaCode: "SJK3H7QX2P", amountKes: 2500, paidAtLocal: utcToZonedLocal(new Date(Date.now() - 86_400_000)), paidTo: "Mookh Africa" };
  setTicketReaderOverride(async () => JSON.stringify(ticketRead));
  setReceiptReaderOverride(async () => JSON.stringify(receiptRead));
});
afterEach(() => {
  setTicketReaderOverride(null);
  setReceiptReaderOverride(null);
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_SCAN_MODEL;
});

describe("M-Pesa code on outside listings", () => {
  it("is optional, normalised to capitals, and must be 10 characters", () => {
    const base = { eventName: "Show", venue: "Venue", city: "Nairobi", startsAtLocal: startLocal, ticketTypeName: "Regular", platform: "Mookh", priceKes: 1000, payoutPhone: "0711000222" };
    expect(externalListingSchema.parse({ ...base, mpesaCode: " sjk3 h7qx2p " }).mpesaCode).toBe("SJK3H7QX2P");
    expect(externalListingSchema.parse({ ...base, mpesaCode: "" }).mpesaCode).toBe("");
    expect(externalListingSchema.parse(base).mpesaCode).toBeUndefined();
    expect(externalListingSchema.safeParse({ ...base, mpesaCode: "ABC" }).success).toBe(false);
  });
});

describe("verification bot", () => {
  it("runs in the background on submit and green-lights a ticket that checks out, without approving it", async () => {
    const l = await submit((await makeUser()).id);
    expect(l.checkStatus).toBe("pending");
    await processDueJobs(10);
    const after = await listing(l.id);
    const result = after.checkResult as CheckResult;
    expect(result.items.filter((i) => i.status !== "ok")).toEqual([]);
    expect(after.checkStatus).toBe("passed");
    expect(after.status).toBe("pending_review"); // only an admin approves
    expect(after.reviewedBy).toBeNull();
  });

  it("flags a wrong event, a different M-Pesa code and a payment after the event", async () => {
    const l = await submit((await makeUser()).id);
    ticketRead = { ...ticketRead, eventName: "Koroga Festival" };
    receiptRead = { ...receiptRead, mpesaCode: "QWE1234567", paidAtLocal: utcToZonedLocal(new Date(start.getTime() + 3600_000)) };
    expect(await verifyExternalListing(l.id)).toBe("flagged");
    const failed = ((await listing(l.id)).checkResult as CheckResult).items.filter((i) => i.status === "fail").map((i) => i.label);
    expect(failed).toEqual(expect.arrayContaining(["Event name", "M-Pesa code", "Payment date"]));
  });

  it("flags an M-Pesa code or order number already used on another listing", async () => {
    const first = await submit((await makeUser()).id);
    const second = await submit((await makeUser()).id);
    expect(await verifyExternalListing(second.id)).toBe("flagged");
    const items = ((await listing(second.id)).checkResult as CheckResult).items;
    expect(items.find((i) => i.label === "M-Pesa code reuse")).toMatchObject({ status: "fail" });
    expect(items.find((i) => i.label === "M-Pesa code reuse")!.detail).toContain(first.reference);
    expect(items.find((i) => i.label === "Order number reuse")).toMatchObject({ status: "fail" });
  });

  it("flags a listing with no M-Pesa code, and says so when the document reader isn't set up", async () => {
    const l = await submit((await makeUser()).id, { mpesaCode: "" });
    delete process.env.OPENAI_SCAN_MODEL;
    expect(await verifyExternalListing(l.id)).toBe("flagged");
    const items = ((await listing(l.id)).checkResult as CheckResult).items;
    expect(items.find((i) => i.label === "Ticket file")!.detail).toMatch(/isn't set up/);
    expect(items.find((i) => i.label === "M-Pesa code")).toMatchObject({ status: "warn" });
  });

  it("compares names by words, ignoring case and punctuation", () => {
    expect(nameSimilarity("Blankets & Wine", "BLANKETS AND WINE — Nairobi")).toBe(1);
    expect(nameSimilarity("Koroga Festival", "Blankets & Wine")).toBe(0);
  });
});

describe("admin replaces the ticket file", () => {
  it("withdraws the old file (kept for admins), serves only the new one, logs the admin and re-runs the checks", async () => {
    const admin = await makeUser("admin");
    const l = await submit((await makeUser()).id);
    await processDueJobs(10);
    const [oldTicket] = await listingDocuments(l.id, ["ticket"]);

    await replaceListingTicketFile(l.id, { filename: "fixed.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 fixed") }, admin.id);
    const current = await listingDocuments(l.id, ["ticket"]);
    expect(current).toHaveLength(1);
    expect(current[0].filename).toBe("fixed.pdf");
    const history = await listingDocumentHistory(l.id);
    expect(history.find((d) => d.id === oldTicket.id)).toMatchObject({ withdrawnByName: admin.name });
    expect(history.find((d) => d.filename === "fixed.pdf")).toMatchObject({ uploadedByName: admin.name, withdrawnAt: null });

    const [a] = await db.select().from(auditLogs).where(eq(auditLogs.action, "resale.ticket_file_replaced"));
    expect(a.actorUserId).toBe(admin.id);
    expect((await listing(l.id)).checkStatus).toBe("pending");
    expect(await db.select().from(jobs).where(and(eq(jobs.type, "resale.verify"), eq(jobs.status, "pending")))).toHaveLength(1);
  });
});

describe("approval log", () => {
  it("shows which admin approved each outside ticket", async () => {
    const admin = await makeUser("admin");
    const l = await submit((await makeUser()).id);
    const end = utcToZonedLocal(new Date(start.getTime() + 6 * 3600_000));
    await approveExternalListing(l.id, { mode: "create", title: "Blankets & Wine", venue: "Ngong Racecourse", city: "Nairobi", category: "festival", startsAtLocal: startLocal, endsAtLocal: end }, admin.id);
    const [row] = await adminListings("active");
    expect(row).toMatchObject({ reviewerName: admin.name, reviewerEmail: admin.email });
  });
});

describe("Buy page catalog", () => {
  it("groups organizer and resale tickets under one event and filters by ticket type and price", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes } = await makeEvent(organizer.id, [
      { name: "Regular", priceKes: 1500, capacity: 100 },
      { name: "VIP", priceKes: 6000, capacity: 20 },
    ]);
    const seller = await makeUser();
    const booking = await buyTickets(event.id, [[ticketTypes[1].id, 1]], { userId: seller.id, email: seller.email });
    const [ticket] = await db.query.tickets.findMany({ where: (t, { eq }) => eq(t.bookingId, booking.id) });
    await createPlatformListing({ ticketId: ticket.id, priceKes: 5000, payoutPhone: "254711000222" }, seller.id);

    const [all] = await buyCatalog({});
    expect(all.id).toBe(event.id);
    expect(all.options.map((o) => [o.kind, o.name])).toEqual([
      ["primary", "Regular"],
      ["resale", "VIP"], // KES 5,000 + 10% fee = 5,500, cheaper than the organizer's VIP
      ["primary", "VIP"],
    ]);

    const [vip] = await buyCatalog({ type: "vip" });
    expect(vip.options.map((o) => o.kind)).toEqual(["resale", "primary"]);
    const [cheap] = await buyCatalog({ maxKes: 2000 });
    expect(cheap.options.map((o) => o.name)).toEqual(["Regular"]);
    expect(await buyCatalog({ type: "student" })).toEqual([]);
  });
});

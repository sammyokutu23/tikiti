import { and, eq } from "drizzle-orm";
import jsQR from "jsqr";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { bookings, checkIns, emailDeliveries, jobs, tickets } from "@/db/schema";
import { confirmBooking, lockBooking } from "@/server/bookings/lifecycle";
import { refundBooking, revokeTicket } from "@/server/bookings/refunds";
import { setEmailTransportOverride } from "@/server/email/transport";
import { processDueJobs } from "@/server/jobs/queue";
import { qrPng } from "@/server/pdf/ticket-pdf";
import { scanTicket } from "@/server/tickets/checkin";
import { renderBookingPdf, renderSingleTicketPdf } from "@/server/tickets/documents";
import { buildQrPayload } from "@/server/tickets/qr";
import { buyTickets, failingTransport, makeEvent, makeOrganizer, memoryTransport, resetDb, customerEmails } from "./helpers";

async function ticketsOf(bookingId: string) {
  return db.select().from(tickets).where(eq(tickets.bookingId, bookingId));
}

describe("check-in", () => {
  beforeEach(resetDb);

  it("accepts a valid ticket once and rejects the repeat scan", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const b = await buyTickets(event.id, [[tt.id, 1]]);
    const [t] = await ticketsOf(b.id);
    const raw = buildQrPayload(t.code);

    const first = await scanTicket({ raw, eventId: event.id, scannerUserId: user.id });
    expect(first.result).toBe("accepted");
    const second = await scanTicket({ raw, eventId: event.id, scannerUserId: user.id });
    expect(second.result).toBe("already_checked_in");
    expect(second.ticket?.checkedInAt).toBe(first.ticket?.checkedInAt);

    const [row] = await db.select().from(tickets).where(eq(tickets.id, t.id));
    expect(row.status).toBe("checked_in");
    expect(row.checkedInBy).toBe(user.id);
    expect(await db.$count(checkIns, eq(checkIns.ticketId, t.id))).toBe(2);
  });

  it("admits exactly one of several simultaneous scans", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const b = await buyTickets(event.id, [[tt.id, 1]]);
    const [t] = await ticketsOf(b.id);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => scanTicket({ raw: buildQrPayload(t.code), eventId: event.id, scannerUserId: user.id })),
    );
    expect(results.filter((r) => r.result === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.result === "already_checked_in")).toHaveLength(5);
  });

  it("rejects refunded, revoked, forged and wrong-event tickets", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const { event: other } = await makeEvent(organizer.id);
    const refunded = await buyTickets(event.id, [[tt.id, 1]]);
    const revoked = await buyTickets(event.id, [[tt.id, 1]]);
    const fine = await buyTickets(event.id, [[tt.id, 1]]);

    await db.transaction((tx) => refundBooking(tx, { bookingId: refunded.id, actorUserId: user.id, reason: "Requested", returnInventory: true }));
    const [rv] = await ticketsOf(revoked.id);
    await revokeTicket({ ticketId: rv.id, actorUserId: user.id, reason: "Fraud" });
    const [rf] = await ticketsOf(refunded.id);
    const [ok] = await ticketsOf(fine.id);

    const scan = (raw: string, eventId = event.id) => scanTicket({ raw, eventId, scannerUserId: user.id });
    expect((await scan(buildQrPayload(rf.code))).result).toBe("refunded");
    expect((await scan(buildQrPayload(rv.code))).result).toBe("revoked");
    expect((await scan(buildQrPayload(ok.code), other.id)).result).toBe("wrong_event");
    expect((await scan(`TKT1.${ok.code}.AAAAAAAAAAAAAAAAAAAAAA`)).result).toBe("invalid");
    expect((await scan("TKT1.ZZZZ-ZZZZ-ZZZZ-ZZZZ.x")).result).toBe("invalid");
    expect((await scan("hello world")).result).toBe("invalid");
    // a forged-looking code that's well-formed but nonexistent
    expect((await scan(buildQrPayload("2222-3333-4444-5555"))).result).toBe("invalid");
  });
});

describe("ticket PDFs", () => {
  beforeEach(resetDb);

  it("renders one page per ticket with a decodable QR code", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [ga, vip] } = await makeEvent(organizer.id, [
      { name: "GA", priceKes: 1000, capacity: 10 },
      { name: "VIP", priceKes: 5000, capacity: 10 },
    ]);
    const b = await buyTickets(event.id, [[ga.id, 2], [vip.id, 1]]);
    const pdf = await renderBookingPdf(b.id);
    expect(Buffer.from(pdf.bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.filename).toMatch(new RegExp(`^tikosoko-.+-${b.reference}\\.pdf$`));
    const doc = await PDFDocument.load(pdf.bytes);
    expect(doc.getPageCount()).toBe(3);

    const [t] = await ticketsOf(b.id);
    const single = await renderSingleTicketPdf(b.id, t.id);
    expect((await PDFDocument.load(single.bytes)).getPageCount()).toBe(1);
    expect(single.filename).toContain(t.code);

    // The exact QR image embedded in the PDF decodes back to the signed payload.
    const png = PNG.sync.read(await qrPng(buildQrPayload(t.code)));
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(buildQrPayload(t.code));
    expect(decoded?.data).not.toContain("@"); // no email / personal data
  });
});

describe("confirmation email", () => {
  beforeEach(async () => {
    await resetDb();
    setEmailTransportOverride(memoryTransport);
  });

  it("attaches a PDF with every ticket and links to the secure booking page", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    const b = await buyTickets(event.id, [[tt.id, 3]]);
    await processDueJobs();
    expect(customerEmails()).toHaveLength(1);
    const mail = customerEmails()[0];
    expect(mail.to).toBe("jane@example.com");
    expect(mail.subject).toContain(b.reference);
    expect(mail.html).toContain(`/bookings/${b.reference}?access=`);
    expect(mail.attachments).toHaveLength(1);
    const doc = await PDFDocument.load(mail.attachments![0].content);
    expect(doc.getPageCount()).toBe(3);
    const [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, b.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("captured");
    expect(d.attachmentCount).toBe(1);
  });

  it("a failed send keeps the booking, is retried, and never duplicates tickets", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    setEmailTransportOverride(failingTransport);
    const b = await buyTickets(event.id, [[tt.id, 2]]);
    await processDueJobs();

    let [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, b.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("retry_pending"); // will retry
    expect(d.lastError).toMatch(/SMTP connection refused/);
    const [b1] = await db.select().from(bookings).where(eq(bookings.id, b.id));
    expect(b1.status).toBe("confirmed");
    expect(await db.$count(tickets, eq(tickets.bookingId, b.id))).toBe(2);

    // Provider recovers; job becomes due again.
    setEmailTransportOverride(memoryTransport);
    await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.type, "email.send"));
    await processDueJobs();
    [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, b.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("captured");
    expect(d.attempts).toBe(2);
    expect(customerEmails()).toHaveLength(1);

    // Re-confirming (e.g. replayed transition) is a no-op: no new tickets or emails.
    await db.transaction(async (tx) => {
      const locked = await lockBooking(tx, b.id);
      await confirmBooking(tx, locked!, { free: false });
    });
    expect(await db.$count(tickets, eq(tickets.bookingId, b.id))).toBe(2);
    expect(await db.$count(emailDeliveries, and(eq(emailDeliveries.bookingId, b.id), eq(emailDeliveries.kind, "booking_confirmation")))).toBe(1);
  });

  it("marks the delivery failed after the final attempt", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id);
    setEmailTransportOverride(failingTransport);
    const b = await buyTickets(event.id, [[tt.id, 1]]);
    for (let i = 0; i < 6; i++) {
      await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.type, "email.send"));
      await processDueJobs();
    }
    const [d] = await db.select().from(emailDeliveries).where(and(eq(emailDeliveries.bookingId, b.id), eq(emailDeliveries.kind, "booking_confirmation")));
    expect(d.status).toBe("failed");
    const [j] = await db.select().from(jobs).where(eq(jobs.type, "email.send"));
    expect(j.status).toBe("failed");
    expect((await db.select().from(bookings).where(eq(bookings.id, b.id)))[0].status).toBe("confirmed");
  });
});

/**
 * Adds resale scenarios on top of the demo seed, for checking where resale
 * tickets appear (home page, /events filters, /resale). Dev only; runs once.
 *
 *   npx tsx scripts/seed-resale.ts
 *
 * Two demo sellers buy tickets through the real checkout (mock M-Pesa, whatever
 * .env says), then list them through the real listing, review and cancel flows.
 */
import "dotenv/config";
import { and, eq, inArray, sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { events, resaleListings, tickets, ticketTypes, users } from "@/db/schema";
import { randomToken } from "@/lib/crypto";
import { createCheckout } from "@/server/bookings/checkout";
import { processDueJobs } from "@/server/jobs/queue";
import { buildMockCallback, MOCK_SIGNATURE_HEADER } from "@/server/payments/providers/mock";
import { handlePaymentWebhook, startPayment } from "@/server/payments/service";
import {
  approveExternalListing,
  cancelListing,
  createExternalListing,
  createPlatformListing,
  rejectExternalListing,
} from "@/server/resale/listings";

const DAY = 86_400_000;

/** A Nairobi wall-clock time `days` from today, as the "YYYY-MM-DDTHH:mm" a form would send. */
function localAt(days: number, hh: number) {
  const d = new Date(Date.now() + days * DAY);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(d);
  return `${date}T${String(hh).padStart(2, "0")}:00`;
}

// A one-page PDF stands in for the uploaded ticket and receipt.
const pdf = (name: string) => ({
  filename: `${name}.pdf`,
  contentType: "application/pdf",
  data: Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"),
});
const docs = { ticket: pdf("ticket"), proof: pdf("receipt") };

// Never send real STK prompts or emails from a demo script.
process.env.PAYMENT_PROVIDER = "mock";
process.env.MPESA_PROVIDER = "mock";
process.env.EMAIL_TRANSPORT = "dev-capture";

const SELLERS = [
  { email: "mercy.resale@example.com", name: "Mercy Njeri", phone: "254711222333" },
  { email: "daniel.resale@example.com", name: "Daniel Kiprop", phone: "254700111444" },
];

/** Buys tickets as `buyer` through checkout and a mock M-Pesa payment; returns the ticket ids. */
async function buy(buyer: typeof users.$inferSelect, slug: string, typeName: string, quantity: number) {
  const [ev] = await db.select().from(events).where(eq(events.slug, slug));
  if (!ev) throw new Error(`Demo event ${slug} not found. Run \`npm run db:seed\` first.`);
  const [tt] = await db.select().from(ticketTypes).where(and(eq(ticketTypes.eventId, ev.id), eq(ticketTypes.name, typeName)));
  const booking = await createCheckout(
    { eventId: ev.id, items: [{ ticketTypeId: tt.id, quantity }], buyerName: buyer.name, buyerEmail: buyer.email, buyerPhone: buyer.phone!, idempotencyKey: `resale-seed-${randomToken(12)}` },
    buyer.id,
  );
  if (booking.totalMinor > 0) {
    const { paymentId } = await startPayment({ booking, method: "mpesa", payerPhone: buyer.phone!, idempotencyKey: `resale-seedpay-${randomToken(12)}`, returnUrl: "/" });
    const [p] = (await db.execute<{ provider_reference: string }>(sql`select provider_reference from payment_transactions where id = ${paymentId}`)).rows;
    const cb = buildMockCallback({ providerReference: p.provider_reference, status: "succeeded", amountMinor: booking.totalMinor, currency: "KES" });
    await handlePaymentWebhook("mock", cb.body, new Headers({ [MOCK_SIGNATURE_HEADER]: cb.signature }));
  }
  const rows = await db.select({ id: tickets.id }).from(tickets).where(eq(tickets.bookingId, booking.id)).orderBy(tickets.sequence);
  if (rows.length !== quantity) throw new Error(`Booking for ${slug} wasn't confirmed.`);
  return rows.map((r) => r.id);
}

async function main() {
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to run in production");

  const [admin] = await db.select().from(users).where(eq(users.role, "admin")).limit(1);
  if (!admin) throw new Error("No admin user found. Run `npm run db:seed` first.");
  const existing = await db.select().from(users).where(inArray(users.email, SELLERS.map((x) => x.email)));
  if (existing.length) {
    console.log("Resale scenarios were already added (demo sellers exist). Nothing to do.");
    return;
  }
  const [seller, seller2] = await db.insert(users).values(SELLERS.map((x) => ({ ...x, role: "customer" as const }))).returning();

  const [vipTicket] = await buy(seller, "afrosonic-live-nairobi", "VIP", 1);
  const [regularTicket] = await buy(seller2, "afrosonic-live-nairobi", "Regular", 1);
  const [festTicket] = await buy(seller, "savannah-sound-festival-2026", "Regular 2-Day", 1);
  const [summitTicket] = await buy(seller2, "nairobi-tech-summit-2026", "Standard Pass", 1);
  const [danceTicket] = await buy(seller2, "dance-kenya-showcase", "Regular", 1);
  const payoutPhone = seller.phone!;
  const shown: string[] = [];
  const hidden: string[] = [];

  // ── Shown: TikoSoko tickets listed by their owner ──
  const vip = await createPlatformListing({ ticketId: vipTicket, priceKes: 5500, payoutPhone }, seller.id);
  shown.push(`${vip.reference}  Afrosonic Live VIP, KES 5,500 · music, Nairobi, Sat 24 Oct`);
  const regular = await createPlatformListing({ ticketId: regularTicket, priceKes: 2200, payoutPhone: seller2.phone! }, seller2.id);
  shown.push(`${regular.reference}  Afrosonic Live Regular, KES 2,200 · music, Nairobi, Sat 24 Oct`);
  const fest = await createPlatformListing({ ticketId: festTicket, priceKes: 4000, payoutPhone }, seller.id);
  shown.push(`${fest.reference}  Savannah Sound Festival Regular 2-Day, KES 4,000 · festival, Nairobi, Sat 7 Nov`);
  const summit = await createPlatformListing({ ticketId: summitTicket, priceKes: 7000, payoutPhone: seller2.phone! }, seller2.id);
  shown.push(`${summit.reference}  Nairobi Tech Summit Standard Pass, KES 7,000 · conference, Nairobi, Sat 14 Nov`);

  // ── Shown: outside ticket matched to an event already on TikoSoko ──
  const [mombasa] = await db.select().from(events).where(eq(events.slug, "mombasa-beats-beach-party"));
  const linked = await createExternalListing(
    { eventName: "Mombasa Beats Beach Party", venue: "Nyali Beach", city: "Mombasa", startsAtLocal: localAt(21, 15), ticketTypeName: "VIP Cabana", platform: "Ticketsasa", orderRef: "TS-88213", note: "Bought two, friend cancelled.", priceKes: 3800, payoutPhone },
    docs,
    seller.id,
  );
  await approveExternalListing(linked.id, { mode: "link", eventId: mombasa.id }, admin.id);
  shown.push(`${linked.reference}  Mombasa Beats VIP Cabana, KES 3,800 · outside ticket, nightlife, Mombasa`);

  // ── Shown: outside ticket for an event that isn't on TikoSoko (resale only) ──
  const created = await createExternalListing(
    { eventName: "Blankets & Wine Nairobi", venue: "Ngong Racecourse", city: "Nairobi", startsAtLocal: localAt(10, 13), ticketTypeName: "General Admission", platform: "Mookh", orderRef: "MK-5521", note: "", priceKes: 4500, payoutPhone },
    docs,
    seller.id,
  );
  await approveExternalListing(
    created.id,
    { mode: "create", title: "Blankets & Wine Nairobi", venue: "Ngong Racecourse", city: "Nairobi", category: "festival", startsAtLocal: localAt(10, 13), endsAtLocal: localAt(10, 22) },
    admin.id,
  );
  shown.push(`${created.reference}  Blankets & Wine General Admission, KES 4,500 · outside event, festival, Nairobi, ${localAt(10, 13).slice(0, 10)}`);

  // ── Hidden: waiting for admin review ──
  const pending = await createExternalListing(
    { eventName: "Sol Fest 2026", venue: "Uhuru Gardens", city: "Nairobi", startsAtLocal: localAt(30, 14), ticketTypeName: "VIP", platform: "Hustle Sasa", orderRef: "", note: "", priceKes: 7000, payoutPhone },
    docs,
    seller.id,
  );
  hidden.push(`${pending.reference}  Sol Fest VIP, waiting for review (approve it in /admin/resale and it appears)`);

  // ── Hidden: rejected by admin ──
  const rejected = await createExternalListing(
    { eventName: "Koroga Festival", venue: "Two Rivers", city: "Nairobi", startsAtLocal: localAt(14, 12), ticketTypeName: "Regular", platform: "Unknown", orderRef: "", note: "", priceKes: 2500, payoutPhone },
    docs,
    seller.id,
  );
  await rejectExternalListing(rejected.id, "The receipt doesn't match the ticket.", admin.id);
  hidden.push(`${rejected.reference}  Koroga Regular, rejected`);

  // ── Hidden: withdrawn by the seller ──
  const withdrawn = await createPlatformListing({ ticketId: danceTicket, priceKes: 1000, payoutPhone: seller2.phone! }, seller2.id);
  await cancelListing(withdrawn.id, { id: seller2.id, role: seller2.role });
  hidden.push(`${withdrawn.reference}  Dance Kenya Showcase Regular, withdrawn by the seller`);

  // Deliver the seller emails the reviews queued (captured locally in dev).
  for (let i = 0; i < 10; i++) {
    const r = await processDueJobs(20);
    if (r.processed === 0) break;
  }

  const live = await db.select({ ref: resaleListings.reference }).from(resaleListings).where(inArray(resaleListings.status, ["active"]));
  console.log(`
Resale scenarios added (${live.length} for sale). Sellers: Mercy Njeri and Daniel Kiprop (*.resale@example.com).

Should appear on /, /events and /resale:
${shown.map((s) => `  ✓ ${s}`).join("\n")}

Should NOT appear anywhere public:
${hidden.map((s) => `  ✗ ${s}`).join("\n")}

Filter checks on /events:
  • Category Music       → only the two Afrosonic tickets
  • Category Festival    → Savannah Sound and Blankets & Wine
  • City Mombasa         → only the Mombasa Beats ticket
  • When "This week"     → only the two Afrosonic tickets
  • Search "blankets"    → only the Blankets & Wine ticket
  • Category Comedy      → no resale box at all
(The home page and the /events box show the 6 newest; /resale lists all of them.)
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

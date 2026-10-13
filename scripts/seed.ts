/**
 * Seeds realistic Kenyan demo data. Refuses to run on a non-empty database
 * unless --reset is passed (which truncates all app tables — dev only).
 *
 *   npm run db:seed            # empty DB only
 *   npm run db:seed -- --reset # wipe & reseed (refuses when NODE_ENV=production)
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { events, organizerProfiles, platformSettings, tickets, ticketTypes, users } from "@/db/schema";
import { createCheckout } from "@/server/bookings/checkout";
import { startPayment, handlePaymentWebhook } from "@/server/payments/service";
import { buildMockCallback, MOCK_SIGNATURE_HEADER } from "@/server/payments/providers/mock";
import { randomToken } from "@/lib/crypto";
import { processDueJobs } from "@/server/jobs/queue";
import { DEMO_LOCATIONS } from "./demo-locations";

const img = (id: string) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=1600&q=80`;
const DAY = 86_400_000;

/** A Nairobi wall-clock time `days` from today. */
function at(days: number, hh: number, mm = 0) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(new Date());
  const base = new Date(`${today}T00:00:00+03:00`).getTime();
  return new Date(base + days * DAY + (hh * 60 + mm) * 60_000);
}

const KES = (n: number) => n * 100;

async function main() {
  const reset = process.argv.includes("--reset");
  const [{ count }] = (await db.execute<{ count: number }>(sql`select count(*)::int as count from users`)).rows;
  if (count > 0 && !reset) {
    console.log("Database already has data. Re-run with --reset to wipe and reseed (dev only).");
    return;
  }
  if (reset) {
    if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production");
    await db.execute(sql`TRUNCATE audit_logs, jobs, email_deliveries, platform_settings, ledger_entries, refunds,
      check_ins, tickets, payment_events, payment_transactions, booking_items, bookings, ticket_types,
      event_reports, events, organizer_profiles, password_reset_tokens, sessions, users CASCADE`);
    console.log("Wiped existing data.");
  }

  await db.insert(platformSettings).values({ key: "commission_bps", value: 500 });

  const [admin, org1User, org2User, pendingUser, customer] = await db
    .insert(users)
    .values([
      { email: "admin@tikiti.test", name: "Achieng Otieno", phone: "254711000001", role: "admin" },
      { email: "organizer@tikiti.test", name: "Brian Mwangi", phone: "254722000002", role: "organizer" },
      { email: "organizer2@tikiti.test", name: "Fatuma Hassan", phone: "254733000003", role: "organizer" },
      { email: "pending@tikiti.test", name: "Kevin Ochieng", phone: "254744000004", role: "customer" },
      { email: "customer@tikiti.test", name: "Wanjiku Kamau", phone: "254712345678", role: "customer" },
    ])
    .returning();

  const [org1, org2, orgPending] = await db
    .insert(organizerProfiles)
    .values([
      {
        userId: org1User.id,
        displayName: "Nairobi Live Co.",
        slug: "nairobi-live-co",
        bio: "Concerts, festivals and late-night sessions across Nairobi since 2016.",
        contactEmail: "hello@nairobilive.example",
        contactPhone: "254722000002",
        city: "Nairobi",
        verificationStatus: "verified",
        verifiedAt: new Date(),
        verifiedBy: admin.id,
      },
      {
        userId: org2User.id,
        displayName: "Savannah Events Ltd",
        slug: "savannah-events",
        bio: "Conferences, sports and community experiences from the coast to the lake.",
        contactEmail: "events@savannah.example",
        contactPhone: "254733000003",
        city: "Mombasa",
        verificationStatus: "verified",
        verifiedAt: new Date(),
        verifiedBy: admin.id,
      },
      {
        userId: pendingUser.id,
        displayName: "Pwani Vibes Entertainment",
        slug: "pwani-vibes",
        bio: "Beach parties and coastal culture nights.",
        contactEmail: "kevin@pwanivibes.example",
        contactPhone: "254744000004",
        city: "Mombasa",
        verificationStatus: "pending",
      },
    ])
    .returning();

  type TT = { name: string; price: number; capacity: number; description?: string; sold?: number; salesEndDays?: number; max?: number };
  type Ev = {
    org: string;
    slug: string;
    title: string;
    summary: string;
    description: string;
    category: (typeof events.$inferInsert)["category"];
    image: string;
    venueName: string;
    venueAddress: string;
    city: string;
    start: Date;
    end: Date;
    featured?: boolean;
    status?: "draft" | "published";
    refundPolicy?: string;
    types: TT[];
  };

  const STANDARD_POLICY =
    "Tickets are refundable up to 7 days before the event, less any payment processing costs. If the event is cancelled you'll receive a full refund automatically. Tickets are not transferable after check-in.";
  const NO_REFUND = "All sales are final except if the event is cancelled or rescheduled, in which case you'll receive a full refund.";

  const evs: Ev[] = [
    {
      org: org1.id,
      slug: "afrosonic-live-nairobi",
      title: "Afrosonic Live: Nairobi",
      summary: "A night of Afro-fusion, benga and live brass under the stars.",
      description:
        "Afrosonic Live returns to Nairobi with a full live band, a 12-piece brass section and special guests from across East Africa.\n\nExpect three stages of sound — from classic benga and rhumba to the newest Afro-fusion and amapiano crossovers. Food trucks from Nairobi's favourite kitchens, a cashless bar (M-Pesa accepted) and secure parking on site.\n\nGates open at 4:00 PM. The headline set starts at 8:30 PM.",
      category: "music",
      image: "1501386761578-eac5c94b800a",
      venueName: "Carnivore Grounds",
      venueAddress: "Langata Road",
      city: "Nairobi",
      start: at(12, 16),
      end: at(12, 23, 30),
      featured: true,
      refundPolicy: STANDARD_POLICY,
      types: [
        { name: "Early Bird", price: 1800, capacity: 300, description: "Limited early release", salesEndDays: -1 },
        { name: "Regular", price: 2500, capacity: 2500, description: "General admission" },
        { name: "VIP", price: 6000, capacity: 300, description: "Raised viewing deck, fast-track entry and a VIP bar", max: 6 },
      ],
    },
    {
      org: org1.id,
      slug: "savannah-sound-festival-2026",
      title: "Savannah Sound Festival 2026",
      summary: "Two days, four stages and 40+ artists at Ngong Racecourse.",
      description:
        "Kenya's biggest weekend of live music. Savannah Sound brings together 40+ artists across Afrobeats, gengetone, reggae, house and jazz on four stages.\n\nYour ticket covers both days. There's a family zone until 6 PM, an art market and a dedicated chill-out garden. Free shuttles run from the CBD (Kencom) every 30 minutes.",
      category: "festival",
      image: "1506157786151-b8491531f063",
      venueName: "Ngong Racecourse",
      venueAddress: "Ngong Road",
      city: "Nairobi",
      start: at(26, 12),
      end: at(27, 23, 59),
      featured: true,
      refundPolicy: STANDARD_POLICY,
      types: [
        { name: "Early Bird 2-Day", price: 3500, capacity: 4, description: "First 4 tickets at a special price" },
        { name: "Regular 2-Day", price: 4500, capacity: 5000 },
        { name: "VIP 2-Day", price: 12000, capacity: 600, description: "VIP lounge, private washrooms, front-of-stage access", max: 6 },
        { name: "VVIP Table (6 pax)", price: 60000, capacity: 20, description: "Reserved table for six with bottle service", max: 2 },
      ],
    },
    {
      org: org1.id,
      slug: "jazz-on-the-lawn",
      title: "Jazz on the Lawn",
      summary: "Sunday afternoon jazz, picnic blankets and good company.",
      description:
        "Bring a blanket and settle in for an afternoon of live jazz in the shade of the Arboretum's old trees. Featuring a saxophone quartet, a Nairobi big band and an open jam session to close.\n\nPicnic baskets are welcome. No glass, please.",
      category: "music",
      image: "1415201364774-f6f0bb35f28f",
      venueName: "Nairobi Arboretum",
      venueAddress: "Arboretum Drive, off State House Road",
      city: "Nairobi",
      start: at(5, 14),
      end: at(5, 19),
      refundPolicy: STANDARD_POLICY,
      types: [
        { name: "Regular", price: 2000, capacity: 400 },
        { name: "Couples (2 pax)", price: 3500, capacity: 100, description: "Admits two" },
      ],
    },
    {
      org: org1.id,
      slug: "rooftop-amapiano-sundays",
      title: "Rooftop Amapiano Sundays",
      summary: "Sunset to late — the city's favourite rooftop party.",
      description:
        "Log drums, skyline views and a sunset you won't forget. Resident DJs play amapiano and afro-house from 5 PM until late. Strictly 18+. Smart casual dress code.",
      category: "nightlife",
      image: "1566737236500-c8ac43014a67",
      venueName: "Skyline Lounge",
      venueAddress: "Argwings Kodhek Road, Kilimani",
      city: "Nairobi",
      start: at(3, 17),
      end: at(4, 2),
      refundPolicy: NO_REFUND,
      types: [
        { name: "Regular", price: 1000, capacity: 350 },
        { name: "VIP Booth", price: 3500, capacity: 40, description: "Booth seating and a welcome drink" },
      ],
    },
    {
      org: org1.id,
      slug: "open-mic-poetry-spoken-word",
      title: "Open Mic: Poetry & Spoken Word",
      summary: "Free monthly open mic — poets, storytellers and musicians welcome.",
      description:
        "Our monthly open mic for poets, storytellers and acoustic musicians. Sign up at the door for a 5-minute slot, or just come to listen. Free entry, but please book so we can manage capacity.",
      category: "arts",
      image: "1475721027785-f74eccf877e2",
      venueName: "Alliance Française",
      venueAddress: "Loita Street",
      city: "Nairobi",
      start: at(8, 18),
      end: at(8, 21),
      refundPolicy: "Free event — if you can't make it, please cancel so someone else can attend.",
      types: [{ name: "Free Entry", price: 0, capacity: 120, max: 4 }],
    },
    {
      org: org1.id,
      slug: "watercolour-and-wine-westlands",
      title: "Watercolour & Wine Workshop",
      summary: "A relaxed beginner's watercolour class with a glass of wine.",
      description:
        "No experience needed. Our resident artist walks you through a Kenyan landscape in watercolour, step by step. All materials, an apron and two glasses of wine (or mocktails) are included. You'll take your painting home.",
      category: "workshop",
      image: "1513364776144-60967b0f800f",
      venueName: "The Art Space",
      venueAddress: "Woodvale Grove, Westlands",
      city: "Nairobi",
      start: at(9, 15),
      end: at(9, 18),
      refundPolicy: "Full refund up to 48 hours before the class. After that, you may transfer your seat to a friend.",
      types: [{ name: "Workshop Seat", price: 3500, capacity: 20, max: 4 }],
    },
    {
      org: org1.id,
      slug: "dance-kenya-showcase",
      title: "Dance Kenya Showcase",
      summary: "Contemporary and traditional dance companies on one stage.",
      description:
        "Six dance companies from Nairobi, Mombasa and Kisumu present new work blending contemporary choreography with traditional Kenyan dance. A celebration of movement and storytelling.",
      category: "arts",
      image: "1547153760-18fc86324498",
      venueName: "Kenya National Theatre",
      venueAddress: "Harry Thuku Road",
      city: "Nairobi",
      start: at(19, 19),
      end: at(19, 21, 30),
      refundPolicy: STANDARD_POLICY,
      types: [
        { name: "Regular", price: 1200, capacity: 350 },
        { name: "Student", price: 600, capacity: 100, description: "Valid student ID required at entry" },
      ],
    },
    {
      org: org2.id,
      slug: "nairobi-tech-summit-2026",
      title: "Nairobi Tech Summit 2026",
      summary: "Two days of talks, workshops and investor meetings for East Africa's builders.",
      description:
        "Hear from founders, engineers and investors building across fintech, agritech, climate and AI. 60+ speakers, hands-on workshops and a startup expo.\n\nYour pass includes lunch and refreshments on both days. Bring your ID for badge collection.",
      category: "conference",
      image: "1540575467063-178a50c2df87",
      venueName: "KICC",
      venueAddress: "Harambee Avenue",
      city: "Nairobi",
      start: at(33, 8, 30),
      end: at(34, 17, 30),
      featured: true,
      refundPolicy: "Refundable until 14 days before the summit. Passes may be transferred to a colleague at any time by contacting support.",
      types: [
        { name: "Early Bird Pass", price: 6000, capacity: 300, salesEndDays: 10 },
        { name: "Standard Pass", price: 8000, capacity: 1200 },
        { name: "Student Pass", price: 2500, capacity: 200, description: "Valid student ID required" },
      ],
    },
    {
      org: org2.id,
      slug: "lake-naivasha-half-marathon",
      title: "Lake Naivasha Half Marathon",
      summary: "21 km, 10 km and 5 km fun run along the lakeshore.",
      description:
        "Run past flamingos and acacia along one of Kenya's most scenic routes. Race entry includes a timing chip, finisher's medal, T-shirt and post-race refreshments. Kids' 2 km dash is free for under-12s on the day.",
      category: "sports",
      image: "1452626038306-9aae5e071dd3",
      venueName: "Naivasha Sports Club",
      venueAddress: "Moi South Lake Road",
      city: "Naivasha",
      start: at(15, 6, 30),
      end: at(15, 13),
      refundPolicy: "Race entries are non-refundable but may be transferred until 7 days before race day.",
      types: [
        { name: "Half Marathon (21 km)", price: 2500, capacity: 800 },
        { name: "10 km Run", price: 1800, capacity: 800 },
        { name: "5 km Fun Run", price: 800, capacity: 1000 },
      ],
    },
    {
      org: org2.id,
      slug: "mombasa-beats-beach-party",
      title: "Mombasa Beats Beach Party",
      summary: "Sand, sound and the Indian Ocean — the coast's biggest beach party.",
      description:
        "Bongo flava, Afrobeats and coastal taarab remixes on the beach at Nyali. Fire dancers at sunset, a seafood market and DJs until 2 AM.",
      category: "nightlife",
      image: "1533174072545-7a4b6ad7a6c3",
      venueName: "Nyali Public Beach",
      venueAddress: "Mount Kenya Road, Nyali",
      city: "Mombasa",
      start: at(21, 15),
      end: at(22, 2),
      refundPolicy: NO_REFUND,
      types: [
        { name: "Regular", price: 1500, capacity: 1500 },
        { name: "VIP Cabana", price: 4000, capacity: 150 },
      ],
    },
    {
      org: org2.id,
      slug: "lakeside-comedy-night-kisumu",
      title: "Lakeside Comedy Night",
      summary: "Kenya's sharpest stand-up comedians, live in Kisumu.",
      description:
        "Five of Kenya's funniest stand-ups take the stage for a night of sharp observational comedy in English, Swahili and Sheng. Doors open 6:30 PM.",
      category: "comedy",
      image: "1585699324551-f6c309eedeca",
      venueName: "Lakeside Amphitheatre",
      venueAddress: "Oginga Odinga Street",
      city: "Kisumu",
      start: at(17, 19),
      end: at(17, 22),
      refundPolicy: STANDARD_POLICY,
      types: [
        { name: "Regular", price: 1000, capacity: 500 },
        { name: "Front Row", price: 2500, capacity: 40 },
      ],
    },
    {
      org: org2.id,
      slug: "rift-valley-cycling-classic",
      title: "Rift Valley Cycling Classic",
      summary: "A 100 km road race through the highlands of Eldoret.",
      description:
        "Kenya's toughest one-day sportive: 100 km and 50 km routes climbing through the Rift Valley highlands. Support vehicles, water stations and a finish-line festival.",
      category: "sports",
      image: "1517649763962-0c623066013b",
      venueName: "Eldoret Sports Club",
      venueAddress: "Uganda Road",
      city: "Eldoret",
      start: at(40, 7),
      end: at(40, 15),
      refundPolicy: STANDARD_POLICY,
      types: [
        { name: "100 km Classic", price: 3000, capacity: 400 },
        { name: "50 km Challenge", price: 2000, capacity: 400 },
      ],
    },
    {
      org: orgPending.id,
      slug: "diani-sunset-sessions",
      title: "Diani Sunset Sessions",
      summary: "Draft — waiting for organizer verification.",
      description: "Sunset DJ sessions on Diani Beach with coastal food and live percussion. (Draft from an unverified organizer.)",
      category: "nightlife",
      image: "1516450360452-9312f5e86fc7",
      venueName: "Diani Beach",
      venueAddress: "Diani Beach Road",
      city: "Diani",
      start: at(30, 16),
      end: at(30, 23),
      status: "draft",
      refundPolicy: NO_REFUND,
      types: [{ name: "Regular", price: 1500, capacity: 300 }],
    },
  ];

  const created: Record<string, { id: string; types: { id: string; name: string }[] }> = {};
  for (const e of evs) {
    const [row] = await db
      .insert(events)
      .values({
        organizerId: e.org,
        slug: e.slug,
        title: e.title,
        summary: e.summary,
        description: e.description,
        category: e.category,
        coverImageUrl: img(e.image),
        venueName: e.venueName,
        venueAddress: e.venueAddress,
        city: e.city,
        startsAt: e.start,
        endsAt: e.end,
        status: e.status ?? "published",
        publishedAt: e.status === "draft" ? null : new Date(),
        isFeatured: e.featured ?? false,
        refundPolicy: e.refundPolicy ?? STANDARD_POLICY,
        ...(DEMO_LOCATIONS[e.slug]
          ? {
              latitude: DEMO_LOCATIONS[e.slug].lat,
              longitude: DEMO_LOCATIONS[e.slug].lng,
              locationProvider: "manual",
              locationConfirmedAt: new Date(),
              arrivalInstructions: DEMO_LOCATIONS[e.slug].arrival ?? "",
            }
          : {}),
      })
      .returning();
    const types = await db
      .insert(ticketTypes)
      .values(
        e.types.map((t, i) => ({
          eventId: row.id,
          name: t.name,
          description: t.description ?? "",
          priceMinor: KES(t.price),
          capacity: t.capacity,
          maxPerOrder: t.max ?? 10,
          sortOrder: i,
          salesEndAt: t.salesEndDays !== undefined ? new Date(Date.now() + t.salesEndDays * DAY) : null,
        })),
      )
      .returning({ id: ticketTypes.id, name: ticketTypes.name });
    created[e.slug] = { id: row.id, types };
  }

  // ── Demo bookings through the real checkout + mock payment flow ──
  async function book(slug: string, lines: [string, number][], buyer: { name: string; email: string; phone: string; userId?: string }) {
    const ev = created[slug];
    const booking = await createCheckout(
      {
        eventId: ev.id,
        items: lines.map(([name, quantity]) => ({ ticketTypeId: ev.types.find((t) => t.name === name)!.id, quantity })),
        buyerName: buyer.name,
        buyerEmail: buyer.email,
        buyerPhone: buyer.phone,
        idempotencyKey: `seed-${randomToken(12)}`,
      },
      buyer.userId ?? null,
    );
    if (booking.totalMinor === 0) return booking;
    const { paymentId } = await startPayment({
      booking,
      method: "mpesa",
      payerPhone: buyer.phone,
      idempotencyKey: `seedpay-${randomToken(12)}`,
      returnUrl: "/",
    });
    const [p] = (await db.execute<{ provider_reference: string }>(sql`select provider_reference from payment_transactions where id = ${paymentId}`)).rows;
    const cb = buildMockCallback({ providerReference: p.provider_reference, status: "succeeded", amountMinor: booking.totalMinor, currency: "KES" });
    await handlePaymentWebhook("mock", cb.body, new Headers({ [MOCK_SIGNATURE_HEADER]: cb.signature }));
    return booking;
  }

  const wanjiku = { name: customer.name, email: customer.email, phone: customer.phone!, userId: customer.id };
  await book("afrosonic-live-nairobi", [["Regular", 2], ["VIP", 1]], wanjiku);
  await book("jazz-on-the-lawn", [["Couples (2 pax)", 1]], wanjiku);
  await book("open-mic-poetry-spoken-word", [["Free Entry", 2]], wanjiku);
  await book("savannah-sound-festival-2026", [["Early Bird 2-Day", 4]], { name: "Otieno Juma", email: "otieno@example.com", phone: "0722111222" });
  const guests: [string, string, string][] = [
    ["Mercy Njeri", "mercy.njeri@example.com", "0711222333"],
    ["Daniel Kiprop", "dkiprop@example.com", "0700111444"],
    ["Aisha Mohamed", "aisha.m@example.com", "0799555666"],
    ["Peter Kariuki", "pkariuki@example.com", "0733777888"],
  ];
  for (const [name, email, phone] of guests) {
    await book("afrosonic-live-nairobi", [["Regular", 1 + (name.length % 3)]], { name, email, phone });
  }
  await book("nairobi-tech-summit-2026", [["Standard Pass", 2]], { name: "Grace Wambui", email: "grace@example.com", phone: "0710101010" });
  await book("nairobi-tech-summit-2026", [["Student Pass", 1]], { name: "Brian Otieno", email: "brian.o@example.com", phone: "0720202020" });
  await book("lake-naivasha-half-marathon", [["Half Marathon (21 km)", 1], ["5 km Fun Run", 2]], { name: "Faith Chebet", email: "faith@example.com", phone: "0730303030" });
  await book("watercolour-and-wine-westlands", [["Workshop Seat", 2]], { name: "Lucy Achieng", email: "lucy@example.com", phone: "0740404040" });

  // One already checked-in ticket for demoing a repeat scan.
  const [t] = await db.select().from(tickets).where(eq(tickets.eventId, created["afrosonic-live-nairobi"].id)).limit(1);
  if (t) await db.update(tickets).set({ status: "checked_in", checkedInAt: new Date(), checkedInBy: org1User.id }).where(eq(tickets.id, t.id));

  // Deliver queued confirmation emails (captured locally in dev).
  for (let i = 0; i < 10; i++) {
    const r = await processDueJobs(20);
    if (r.processed === 0) break;
  }

  console.log(`
Seed complete. Demo data is owned by local users (admin@, organizer@, organizer2@,
pending@, customer@tikiti.test). Sign-in is via Clerk: to act as one of them,
sign up in the app, then run e.g.
  npm run user:link -- you@example.com organizer@tikiti.test
or grant yourself admin with
  npm run user:role -- you@example.com admin
`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

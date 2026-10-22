/**
 * Resale listings: TikoSoko tickets (verified, reissued to the buyer on sale) and
 * tickets bought on other platforms (reviewed by an admin before going live).
 */
import { and, desc, eq, gt, ilike, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import {
  auditLogs,
  bookingItems,
  bookings,
  eventCategory,
  events,
  organizerProfiles,
  resaleDocuments,
  resaleListings,
  resalePayouts,
  tickets,
  users,
  type ResaleListing,
} from "@/db/schema";
import { randomCode } from "@/lib/crypto";
import { zonedLocalToUtc } from "@/lib/dates";
import { env } from "@/lib/env";
import { isUniqueViolation, UserError } from "@/lib/errors";
import { normalizeKenyanPhone, slugify } from "@/lib/utils";
import { audit } from "../audit";
import { queueEmail } from "../email/queue";
import { type EventSearch, isCategory, searchDateRange } from "../events/queries";
import type { ResaleUpload } from "./documents";
import { MAX_RESALE_PRICE_KES, MIN_RESALE_PRICE_KES } from "./policy";

export const newListingReference = () => {
  const c = randomCode(8);
  return `RS-${c.slice(0, 4)}-${c.slice(4)}`;
};

const priceKes = z.coerce
  .number({ error: "Enter a price in KES" })
  .int("Use whole shillings (M-Pesa has no cents)")
  .min(MIN_RESALE_PRICE_KES, `Minimum price is KES ${MIN_RESALE_PRICE_KES}`)
  .max(MAX_RESALE_PRICE_KES, `Maximum price is KES ${MAX_RESALE_PRICE_KES.toLocaleString("en-KE")}`);

const payoutPhone = z
  .string()
  .trim()
  .transform((v, ctx) => {
    const n = normalizeKenyanPhone(v);
    if (!n) {
      ctx.addIssue({ code: "custom", message: "Enter the M-Pesa number to pay you on, e.g. 0712 345 678" });
      return z.NEVER;
    }
    return n;
  });

export const platformListingSchema = z.object({ ticketId: z.uuid(), priceKes, payoutPhone });

export const externalListingSchema = z.object({
  eventName: z.string().trim().min(3, "Enter the event name").max(160),
  venue: z.string().trim().min(2, "Enter the venue").max(160),
  city: z.string().trim().min(2, "Enter the city").max(80),
  startsAtLocal: z.string().trim().min(1, "Enter the date and time"),
  ticketTypeName: z.string().trim().min(2, "Enter the ticket type, e.g. Regular or VIP").max(80),
  platform: z.string().trim().min(2, "Where did you buy it?").max(80),
  orderRef: z.string().trim().max(120).default(""),
  note: z.string().trim().max(600).default(""),
  priceKes,
  payoutPhone,
});

// ─── Selling ─────────────────────────────────────────────────────────────────

/** Tickets this user can list: theirs, valid, for an upcoming TikoSoko event, not already listed. */
export async function resellableTickets(userId: string) {
  return db
    .select({
      ticketId: tickets.id,
      code: tickets.code,
      typeName: bookingItems.ticketTypeName,
      unitPriceMinor: bookingItems.unitPriceMinor,
      reference: bookings.reference,
      event: { id: events.id, title: events.title, startsAt: events.startsAt, timezone: events.timezone, venueName: events.venueName, city: events.city, coverImageUrl: events.coverImageUrl },
    })
    .from(tickets)
    .innerJoin(bookings, eq(bookings.id, tickets.bookingId))
    .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
    .innerJoin(events, eq(events.id, tickets.eventId))
    .leftJoin(resaleListings, and(eq(resaleListings.ticketId, tickets.id), inArray(resaleListings.status, ["pending_review", "active"])))
    .where(
      and(
        eq(bookings.userId, userId),
        eq(bookings.status, "confirmed"),
        eq(tickets.status, "valid"),
        eq(events.status, "published"),
        gt(events.endsAt, new Date()),
        isNull(resaleListings.id),
      ),
    )
    .orderBy(events.startsAt, tickets.sequence);
}

export async function createPlatformListing(input: z.infer<typeof platformListingSchema>, sellerUserId: string): Promise<ResaleListing> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ ticket: tickets, booking: bookings, event: events, typeName: bookingItems.ticketTypeName })
        .from(tickets)
        .innerJoin(bookings, eq(bookings.id, tickets.bookingId))
        .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
        .innerJoin(events, eq(events.id, tickets.eventId))
        .where(eq(tickets.id, input.ticketId))
        .for("update", { of: tickets });
      // Same message whether the ticket doesn't exist or isn't theirs.
      if (!row || row.booking.userId !== sellerUserId) throw new UserError("Ticket not found.");
      if (row.booking.status !== "confirmed" || row.ticket.status !== "valid") throw new UserError("Only valid, unused tickets can be resold.");
      if (row.event.status !== "published" || row.event.endsAt <= new Date()) throw new UserError("This event has ended or was cancelled.");
      const [listing] = await tx
        .insert(resaleListings)
        .values({
          reference: newListingReference(),
          kind: "platform",
          status: "active",
          sellerUserId,
          eventId: row.event.id,
          ticketId: row.ticket.id,
          ticketTypeName: row.typeName,
          priceMinor: input.priceKes * 100,
          payoutPhone: input.payoutPhone,
        })
        .returning();
      await audit(tx, { actorUserId: sellerUserId, action: "resale.listed", entityType: "resale_listing", entityId: listing.id, metadata: { kind: "platform", ticketCode: row.ticket.code, priceMinor: listing.priceMinor } });
      return listing;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserError("This ticket is already listed for resale.");
    throw err;
  }
}

export async function createExternalListing(
  input: z.infer<typeof externalListingSchema>,
  files: { ticket: ResaleUpload; proof: ResaleUpload },
  sellerUserId: string,
): Promise<ResaleListing> {
  const startsAt = zonedLocalToUtc(input.startsAtLocal);
  if (!startsAt) throw new UserError("Enter a valid event date and time.");
  if (startsAt <= new Date()) throw new UserError("The event must be in the future.");
  return db.transaction(async (tx) => {
    const [listing] = await tx
      .insert(resaleListings)
      .values({
        reference: newListingReference(),
        kind: "external",
        status: "pending_review",
        sellerUserId,
        ticketTypeName: input.ticketTypeName,
        priceMinor: input.priceKes * 100,
        payoutPhone: input.payoutPhone,
        externalEventName: input.eventName,
        externalVenue: input.venue,
        externalCity: input.city,
        externalStartsAt: startsAt,
        externalPlatform: input.platform,
        externalOrderRef: input.orderRef || null,
        sellerNote: input.note,
      })
      .returning();
    await tx.insert(resaleDocuments).values([
      { listingId: listing.id, purpose: "ticket", filename: files.ticket.filename, contentType: files.ticket.contentType, sizeBytes: files.ticket.data.length, data: files.ticket.data },
      { listingId: listing.id, purpose: "proof", filename: files.proof.filename, contentType: files.proof.contentType, sizeBytes: files.proof.data.length, data: files.proof.data },
    ]);
    await audit(tx, { actorUserId: sellerUserId, action: "resale.submitted", entityType: "resale_listing", entityId: listing.id, metadata: { kind: "external", platform: input.platform, priceMinor: listing.priceMinor } });
    return listing;
  });
}

/** A buyer is mid-checkout (unexpired hold) on this listing. */
export async function hasLiveCheckout(tx: Tx, listingId: string) {
  const [b] = await tx
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.resaleListingId, listingId), eq(bookings.status, "pending"), gt(bookings.expiresAt, new Date())))
    .limit(1);
  return !!b;
}

/** Seller (or an admin) withdraws a listing that hasn't sold. */
export async function cancelListing(listingId: string, actor: { id: string; role: string }) {
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(resaleListings).where(eq(resaleListings.id, listingId)).for("update");
    if (!l || (l.sellerUserId !== actor.id && actor.role !== "admin")) throw new UserError("Listing not found.");
    if (l.status !== "active" && l.status !== "pending_review") throw new UserError("Only open listings can be withdrawn.");
    if (await hasLiveCheckout(tx, l.id)) throw new UserError("A buyer is paying for this ticket right now. Try again in about 10 minutes.");
    await tx.update(resaleListings).set({ status: "cancelled", closedAt: new Date(), updatedAt: new Date() }).where(eq(resaleListings.id, l.id));
    await audit(tx, { actorUserId: actor.id, action: "resale.withdrawn", entityType: "resale_listing", entityId: l.id, metadata: { reference: l.reference } });
  });
}

// ─── Admin review of outside tickets ─────────────────────────────────────────

const RESALE_ORGANIZER_SLUG = "tikosoko-resale";

/** Owner of outside events: a system organizer profile (with a user nobody can sign in as). */
async function resaleOrganizerId(tx: Tx): Promise<string> {
  const [existing] = await tx.select({ id: organizerProfiles.id }).from(organizerProfiles).where(eq(organizerProfiles.slug, RESALE_ORGANIZER_SLUG));
  if (existing) return existing.id;
  // .invalid can never receive mail, so no one can verify it and claim this user through Clerk.
  const email = "resale-system@tikosoko.invalid";
  await tx.insert(users).values({ email, name: "TikoSoko Resale" }).onConflictDoNothing();
  const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  const [created] = await tx
    .insert(organizerProfiles)
    .values({
      userId: user.id,
      displayName: "TikoSoko Resale",
      slug: RESALE_ORGANIZER_SLUG,
      contactEmail: env.supportEmail,
      contactPhone: "",
      verificationStatus: "verified",
      verificationNote: "System profile that owns outside events for resale listings.",
    })
    .onConflictDoNothing()
    .returning({ id: organizerProfiles.id });
  if (created) return created.id;
  const [raced] = await tx.select({ id: organizerProfiles.id }).from(organizerProfiles).where(eq(organizerProfiles.slug, RESALE_ORGANIZER_SLUG));
  return raced.id;
}

export const approveExternalSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("link"), eventId: z.uuid("Choose an event") }),
  z.object({
    mode: z.literal("create"),
    title: z.string().trim().min(3).max(160),
    venue: z.string().trim().min(2).max(160),
    city: z.string().trim().min(2).max(80),
    category: z.enum(eventCategory.enumValues),
    startsAtLocal: z.string().min(1),
    endsAtLocal: z.string().min(1),
  }),
]);

export async function approveExternalListing(listingId: string, input: z.infer<typeof approveExternalSchema>, adminId: string): Promise<{ eventId: string }> {
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(resaleListings).where(eq(resaleListings.id, listingId)).for("update");
    if (!l || l.kind !== "external") throw new UserError("Listing not found.");
    if (l.status !== "pending_review") throw new UserError("This listing has already been reviewed.");

    let eventId: string;
    let eventTitle: string;
    if (input.mode === "link") {
      const [ev] = await tx.select().from(events).where(eq(events.id, input.eventId));
      if (!ev || ev.status !== "published" || ev.endsAt <= new Date()) throw new UserError("Choose an upcoming, published event.");
      eventId = ev.id;
      eventTitle = ev.title;
    } else {
      const startsAt = zonedLocalToUtc(input.startsAtLocal);
      const endsAt = zonedLocalToUtc(input.endsAtLocal);
      if (!startsAt || !endsAt || endsAt <= startsAt) throw new UserError("Enter a valid start and end time.");
      if (endsAt <= new Date()) throw new UserError("This event has already ended.");
      const [ev] = await tx
        .insert(events)
        .values({
          organizerId: await resaleOrganizerId(tx),
          slug: `${slugify(input.title) || "event"}-${randomCode(5).toLowerCase()}`,
          title: input.title,
          summary: "Outside event: tickets resold on TikoSoko.",
          category: input.category,
          venueName: input.venue,
          city: input.city,
          startsAt,
          endsAt,
          status: "published",
          isHidden: true,
          hiddenReason: "Outside event (resale only)",
          isExternal: true,
          publishedAt: new Date(),
        })
        .returning();
      eventId = ev.id;
      eventTitle = ev.title;
    }

    await tx
      .update(resaleListings)
      .set({ status: "active", eventId, reviewedBy: adminId, reviewedAt: new Date(), reviewNote: null, updatedAt: new Date() })
      .where(eq(resaleListings.id, l.id));
    await queueSellerReviewEmail(tx, l, { approved: true, eventTitle });
    await audit(tx, { actorUserId: adminId, action: "resale.approved", entityType: "resale_listing", entityId: l.id, metadata: { reference: l.reference, eventId, mode: input.mode } });
    return { eventId };
  });
}

/** Details an admin can withdraw and replace while reviewing an outside ticket (price and payout stay the seller's). */
export const correctedDetailsSchema = externalListingSchema.pick({ eventName: true, venue: true, city: true, startsAtLocal: true, ticketTypeName: true, platform: true, orderRef: true, note: true });

const detailsOf = (l: ResaleListing) => ({
  eventName: l.externalEventName,
  venue: l.externalVenue,
  city: l.externalCity,
  startsAt: l.externalStartsAt?.toISOString() ?? null,
  ticketTypeName: l.ticketTypeName,
  platform: l.externalPlatform,
  orderRef: l.externalOrderRef,
  note: l.sellerNote,
});
export type ListingDetails = ReturnType<typeof detailsOf>;

/** Withdraws the details on a pending outside listing and saves new ones. The old details are kept in the audit log. */
export async function correctExternalListingDetails(listingId: string, input: z.infer<typeof correctedDetailsSchema>, adminId: string) {
  const startsAt = zonedLocalToUtc(input.startsAtLocal);
  if (!startsAt) throw new UserError("Enter a valid event date and time.");
  if (startsAt <= new Date()) throw new UserError("The event must be in the future.");
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(resaleListings).where(eq(resaleListings.id, listingId)).for("update");
    if (!l || l.kind !== "external") throw new UserError("Listing not found.");
    if (l.status !== "pending_review") throw new UserError("Only listings waiting for review can be changed.");
    const [updated] = await tx
      .update(resaleListings)
      .set({
        externalEventName: input.eventName,
        externalVenue: input.venue,
        externalCity: input.city,
        externalStartsAt: startsAt,
        ticketTypeName: input.ticketTypeName,
        externalPlatform: input.platform,
        externalOrderRef: input.orderRef || null,
        sellerNote: input.note,
        updatedAt: new Date(),
      })
      .where(eq(resaleListings.id, l.id))
      .returning();
    await audit(tx, {
      actorUserId: adminId,
      action: "resale.details_replaced",
      entityType: "resale_listing",
      entityId: l.id,
      metadata: { reference: l.reference, withdrawn: detailsOf(l), entered: detailsOf(updated) },
    });
  });
}

/** Details withdrawn from a listing by admins, newest first. */
export async function withdrawnDetails(listingId: string) {
  const rows = await db
    .select({ at: auditLogs.createdAt, metadata: auditLogs.metadata, adminName: users.name })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(and(eq(auditLogs.entityType, "resale_listing"), eq(auditLogs.entityId, listingId), eq(auditLogs.action, "resale.details_replaced")))
    .orderBy(desc(auditLogs.createdAt));
  return rows.map((r) => ({ at: r.at, adminName: r.adminName, details: (r.metadata as { withdrawn: ListingDetails }).withdrawn }));
}

export async function rejectExternalListing(listingId: string, note: string, adminId: string) {
  const reason = note.trim().slice(0, 500);
  if (reason.length < 5) throw new UserError("Tell the seller why the listing was rejected.");
  return db.transaction(async (tx) => {
    const [l] = await tx.select().from(resaleListings).where(eq(resaleListings.id, listingId)).for("update");
    if (!l || l.kind !== "external") throw new UserError("Listing not found.");
    if (l.status !== "pending_review") throw new UserError("This listing has already been reviewed.");
    await tx
      .update(resaleListings)
      .set({ status: "rejected", reviewedBy: adminId, reviewedAt: new Date(), reviewNote: reason, closedAt: new Date(), updatedAt: new Date() })
      .where(eq(resaleListings.id, l.id));
    await queueSellerReviewEmail(tx, l, { approved: false, eventTitle: l.externalEventName ?? "", note: reason });
    await audit(tx, { actorUserId: adminId, action: "resale.rejected", entityType: "resale_listing", entityId: l.id, metadata: { reference: l.reference, reason } });
  });
}

async function queueSellerReviewEmail(tx: Tx, l: ResaleListing, meta: { approved: boolean; eventTitle: string; note?: string }) {
  const [seller] = await tx.select({ email: users.email }).from(users).where(eq(users.id, l.sellerUserId));
  await queueEmail(tx, {
    kind: "resale_listing_reviewed",
    toEmail: seller?.email,
    userId: l.sellerUserId,
    dedupeKey: `resale_listing_reviewed:${l.id}`,
    metadata: { listingId: l.id, ...meta },
  });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const listingCard = {
  listing: resaleListings,
  event: {
    id: events.id,
    slug: events.slug,
    title: events.title,
    startsAt: events.startsAt,
    endsAt: events.endsAt,
    timezone: events.timezone,
    venueName: events.venueName,
    city: events.city,
    category: events.category,
    coverImageUrl: events.coverImageUrl,
    isExternal: events.isExternal,
  },
};

/** Listings a buyer can purchase right now. */
function buyableWhere() {
  return and(
    eq(resaleListings.status, "active"),
    eq(events.status, "published"),
    gt(events.endsAt, new Date()),
    // Platform listings stay buyable only while the seller's ticket is unused and valid.
    or(eq(resaleListings.kind, "external"), eq(tickets.status, "valid")),
  );
}

export async function marketplaceListings(
  filter: { eventId?: string; q?: string; limit?: number; newest?: boolean } & Pick<EventSearch, "category" | "city" | "when" | "date"> = {},
) {
  const conds = [buyableWhere()];
  if (filter.eventId) conds.push(eq(resaleListings.eventId, filter.eventId));
  if (filter.category && isCategory(filter.category)) conds.push(eq(events.category, filter.category));
  if (filter.city?.trim()) conds.push(ilike(events.city, filter.city.trim()));
  const range = searchDateRange(filter);
  if (range) conds.push(lt(events.startsAt, range.end), gt(events.endsAt, range.start));
  const q = filter.q?.trim().toLowerCase();
  const limit = filter.limit ?? 120;
  // "Newest" means newest on sale: outside tickets go live when an admin approves them.
  const order = filter.newest
    ? [desc(sql`coalesce(${resaleListings.reviewedAt}, ${resaleListings.createdAt})`)]
    : [events.startsAt, resaleListings.priceMinor];
  const rows = await db
    .select(listingCard)
    .from(resaleListings)
    .innerJoin(events, eq(events.id, resaleListings.eventId))
    .leftJoin(tickets, eq(tickets.id, resaleListings.ticketId))
    .where(and(...conds))
    .orderBy(...order)
    .limit(q ? 120 : limit);
  return q ? rows.filter((r) => `${r.event.title} ${r.event.venueName} ${r.event.city} ${r.listing.ticketTypeName}`.toLowerCase().includes(q)).slice(0, limit) : rows;
}

export async function getBuyableListing(reference: string) {
  if (!/^RS-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) return null;
  const [row] = await db
    .select(listingCard)
    .from(resaleListings)
    .innerJoin(events, eq(events.id, resaleListings.eventId))
    .leftJoin(tickets, eq(tickets.id, resaleListings.ticketId))
    .where(and(eq(resaleListings.reference, reference), buyableWhere()));
  return row ?? null;
}

export async function sellerListings(userId: string) {
  return db
    .select({ ...listingCard, eventTitle: events.title })
    .from(resaleListings)
    .leftJoin(events, eq(events.id, resaleListings.eventId))
    .where(eq(resaleListings.sellerUserId, userId))
    .orderBy(resaleListings.createdAt);
}

/** Open listings for these tickets (shown on the seller's booking page). */
export async function openListingsForTickets(ticketIds: string[]) {
  if (ticketIds.length === 0) return [];
  return db
    .select({ id: resaleListings.id, ticketId: resaleListings.ticketId, reference: resaleListings.reference, priceMinor: resaleListings.priceMinor })
    .from(resaleListings)
    .where(and(inArray(resaleListings.ticketId, ticketIds), eq(resaleListings.status, "active")));
}

export async function listingDocuments(listingId: string, purposes: ("ticket" | "proof")[] = ["ticket", "proof"]) {
  return db
    .select({ id: resaleDocuments.id, purpose: resaleDocuments.purpose, filename: resaleDocuments.filename, sizeBytes: resaleDocuments.sizeBytes })
    .from(resaleDocuments)
    .where(and(eq(resaleDocuments.listingId, listingId), inArray(resaleDocuments.purpose, purposes)));
}

export async function adminListings(tab: "review" | "active" | "all") {
  const where = tab === "review" ? eq(resaleListings.status, "pending_review") : tab === "active" ? eq(resaleListings.status, "active") : ne(resaleListings.status, "pending_review");
  return db
    .select({ listing: resaleListings, eventTitle: events.title, eventIsExternal: events.isExternal, eventCover: events.coverImageUrl, sellerName: users.name, sellerEmail: users.email })
    .from(resaleListings)
    .leftJoin(events, eq(events.id, resaleListings.eventId))
    .innerJoin(users, eq(users.id, resaleListings.sellerUserId))
    .where(where)
    .orderBy(resaleListings.createdAt)
    .limit(300);
}

/** Upcoming TikoSoko events an outside listing can be linked to. */
export async function linkableEvents() {
  return db
    .select({ id: events.id, title: events.title, startsAt: events.startsAt, timezone: events.timezone, city: events.city })
    .from(events)
    .where(and(eq(events.status, "published"), eq(events.isExternal, false), gt(events.endsAt, new Date())))
    .orderBy(events.startsAt)
    .limit(300);
}

/** Resale details shown on the buyer's booking page. */
export async function resaleForBooking(bookingId: string, listingId: string) {
  const [listing] = await db.select().from(resaleListings).where(eq(resaleListings.id, listingId));
  if (!listing) return null;
  const [payout] = await db.select().from(resalePayouts).where(eq(resalePayouts.bookingId, bookingId));
  const docs = listing.soldBookingId === bookingId ? await listingDocuments(listing.id, ["ticket"]) : [];
  return { listing, payout: payout ?? null, docs };
}

/**
 * Worker maintenance: closes open listings that can no longer sell, because the event
 * is over or cancelled, or the seller's ticket was used, refunded or revoked.
 */
export async function closeEndedListings(now = new Date()): Promise<number> {
  const at = now.toISOString();
  const closed = await db
    .update(resaleListings)
    .set({ status: "closed", closedAt: now, updatedAt: now })
    .where(
      and(
        inArray(resaleListings.status, ["active", "pending_review"]),
        or(
          sql`exists (select 1 from ${events} where ${events.id} = ${resaleListings.eventId} and (${events.endsAt} <= ${at}::timestamptz or ${events.status} = 'cancelled'))`,
          and(isNull(resaleListings.eventId), sql`${resaleListings.externalStartsAt} <= ${at}::timestamptz`),
          sql`exists (select 1 from ${tickets} where ${tickets.id} = ${resaleListings.ticketId} and ${tickets.status} <> 'valid')`,
        ),
      ),
    )
    .returning({ id: resaleListings.id });
  return closed.length;
}

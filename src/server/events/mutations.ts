import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingItems, events, ticketTypes, type Event, type OrganizerProfile, type User } from "@/db/schema";
import { randomCode } from "@/lib/crypto";
import { isValidTimeZone, zonedLocalToUtc } from "@/lib/dates";
import { isValidLatLng, roundCoord } from "@/lib/location";
import { UserError } from "@/lib/errors";
import { parseMajorToMinor } from "@/lib/money";
import { slugify } from "@/lib/utils";
import { audit } from "../audit";
import { canPublish } from "../auth/guards";
import { notifyEventChanged, queueOrganizerEmail } from "../email/notify";
import { CATEGORIES } from "./queries";

const categoryValues = CATEGORIES.map((c) => c.value) as [string, ...string[]];

export const eventFormSchema = z
  .object({
    title: z.string().trim().min(4, "Title is too short").max(120),
    summary: z.string().trim().max(200).default(""),
    description: z.string().trim().min(20, "Add a description of at least 20 characters").max(8000),
    category: z.enum(categoryValues, { message: "Choose a category" }),
    venueName: z.string().trim().min(2, "Venue is required").max(120),
    venueAddress: z.string().trim().max(200).default(""),
    city: z.string().trim().min(2, "City is required").max(60),
    timezone: z.string().refine(isValidTimeZone, "Invalid time zone").default("Africa/Nairobi"),
    startsLocal: z.string().min(1, "Start date & time is required"),
    endsLocal: z.string().min(1, "End date & time is required"),
    refundPolicy: z.string().trim().min(10, "Describe your refund policy").max(2000),
    latitude: z.string().trim().default(""),
    longitude: z.string().trim().default(""),
    locationConfirmed: z.string().default(""),
    locationProvider: z.string().trim().max(40).default(""),
    locationPlaceId: z.string().trim().max(120).default(""),
    arrivalInstructions: z.string().trim().max(500, "Keep arrival instructions under 500 characters").default(""),
    installmentsEnabled: z.string().default(""),
  })
  .transform((v, ctx) => {
    const loc = parseLocation(v, ctx);
    const startsAt = zonedLocalToUtc(v.startsLocal, v.timezone);
    const endsAt = zonedLocalToUtc(v.endsLocal, v.timezone);
    if (!startsAt) ctx.addIssue({ code: "custom", path: ["startsLocal"], message: "Invalid start date" });
    if (!endsAt) ctx.addIssue({ code: "custom", path: ["endsLocal"], message: "Invalid end date" });
    if (startsAt && endsAt && endsAt <= startsAt)
      ctx.addIssue({ code: "custom", path: ["endsLocal"], message: "End must be after start" });
    return { ...v, startsAt: startsAt!, endsAt: endsAt!, location: loc, installmentsEnabled: v.installmentsEnabled === "on" };
  });

export type ParsedLocation = { lat: number; lng: number; provider: string; placeId: string | null } | null;

/** Coordinates are optional at parse time; whether one is *required* is decided per action. */
function parseLocation(
  v: { latitude: string; longitude: string; locationConfirmed: string; locationProvider: string; locationPlaceId: string },
  ctx: z.RefinementCtx,
): ParsedLocation {
  if (!v.latitude && !v.longitude) return null;
  const lat = Number(v.latitude);
  const lng = Number(v.longitude);
  if (!v.latitude || !v.longitude || !isValidLatLng(lat, lng)) {
    ctx.addIssue({ code: "custom", path: ["location"], message: "The map pin is invalid. Search again or place the pin on the map." });
    return null;
  }
  if (v.locationConfirmed !== "1") {
    ctx.addIssue({ code: "custom", path: ["location"], message: "Confirm the pin position with “Confirm pin” before saving." });
    return null;
  }
  const provider = ["nominatim", "manual"].includes(v.locationProvider) ? v.locationProvider : "manual";
  return { lat: roundCoord(lat), lng: roundCoord(lng), provider, placeId: provider === "manual" ? null : v.locationPlaceId || null };
}

export const LOCATION_REQUIRED_MESSAGE = "Set the venue location on the map. Buyers use it for directions.";

function locationColumns(loc: ParsedLocation, current?: Event) {
  if (!loc) return {};
  const unchanged = current && current.latitude === loc.lat && current.longitude === loc.lng;
  return {
    latitude: loc.lat,
    longitude: loc.lng,
    locationProvider: loc.provider,
    locationPlaceId: loc.placeId,
    locationConfirmedAt: unchanged ? current.locationConfirmedAt : new Date(),
  };
}
export type EventFormInput = z.input<typeof eventFormSchema>;

async function uniqueSlug(title: string) {
  const base = slugify(title) || "event";
  for (let i = 0; i < 5; i++) {
    const slug = i === 0 ? base : `${base}-${randomCode(4).toLowerCase()}`;
    const [hit] = await db.select({ id: events.id }).from(events).where(eq(events.slug, slug));
    if (!hit) return slug;
  }
  return `${base}-${randomCode(8).toLowerCase()}`;
}

export async function createEvent(
  ctx: { user: User; organizer: OrganizerProfile },
  input: z.output<typeof eventFormSchema>,
  coverImageUrl: string | null,
) {
  if (!input.location) throw new UserError(LOCATION_REQUIRED_MESSAGE, "location_required");
  const [ev] = await db
    .insert(events)
    .values({
      organizerId: ctx.organizer.id,
      slug: await uniqueSlug(input.title),
      title: input.title,
      summary: input.summary,
      description: input.description,
      category: input.category as Event["category"],
      venueName: input.venueName,
      venueAddress: input.venueAddress,
      city: input.city,
      timezone: input.timezone,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      refundPolicy: input.refundPolicy,
      coverImageUrl,
      arrivalInstructions: input.arrivalInstructions,
      installmentsEnabled: input.installmentsEnabled,
      ...locationColumns(input.location),
      status: "draft",
    })
    .returning();
  await audit(null, { actorUserId: ctx.user.id, action: "event.created", entityType: "event", entityId: ev.id });
  return ev;
}

export async function updateEvent(event: Event, actor: User, input: z.output<typeof eventFormSchema>, coverImageUrl: string | null) {
  if (event.status === "cancelled") throw new UserError("Cancelled events can't be edited.");
  // A pin, once set, can be moved but not removed. Legacy events without one may still be edited.
  if (!input.location && event.latitude !== null) throw new UserError(LOCATION_REQUIRED_MESSAGE, "location_required");
  const ev = await db.transaction(async (tx) => {
    const [ev] = await tx
      .update(events)
      .set({
        title: input.title,
        summary: input.summary,
        description: input.description,
        category: input.category as Event["category"],
        venueName: input.venueName,
        venueAddress: input.venueAddress,
        city: input.city,
        timezone: input.timezone,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        refundPolicy: input.refundPolicy,
        coverImageUrl,
        arrivalInstructions: input.arrivalInstructions,
        installmentsEnabled: input.installmentsEnabled,
        ...locationColumns(input.location, event),
        updatedAt: new Date(),
      })
      .where(eq(events.id, event.id))
      .returning();
    // Ticket holders hear about time/venue changes (fan-out job, one email per booking per change).
    await notifyEventChanged(tx, event, ev);
    return ev;
  });
  const moved = input.location && (event.latitude !== input.location.lat || event.longitude !== input.location.lng);
  await audit(null, {
    actorUserId: actor.id,
    action: "event.updated",
    entityType: "event",
    entityId: ev.id,
    metadata: moved ? { locationFrom: event.latitude === null ? null : [event.latitude, event.longitude], locationTo: [input.location!.lat, input.location!.lng] } : {},
  });
  return ev;
}

/** Organizer opt-in for Lipa Mdogo Mdogo. Existing plans are unaffected either way. */
export async function setInstallmentsEnabled(event: Event, actor: User, enabled: boolean) {
  if (event.status === "cancelled") throw new UserError("Cancelled events can't be changed.");
  await db.update(events).set({ installmentsEnabled: enabled, updatedAt: new Date() }).where(eq(events.id, event.id));
  await audit(null, { actorUserId: actor.id, action: enabled ? "event.installments_enabled" : "event.installments_disabled", entityType: "event", entityId: event.id });
}

export async function publishEvent(event: Event, ctx: { user: User; organizer: OrganizerProfile }) {
  if (!canPublish(ctx.user, ctx.organizer)) {
    throw new UserError("Your organizer account must be verified before you can publish events.", "forbidden", 403);
  }
  if (event.status === "cancelled") throw new UserError("Cancelled events can't be republished.");
  if (event.endsAt <= new Date()) throw new UserError("This event has already ended.");
  if (!isValidLatLng(event.latitude, event.longitude)) throw new UserError(`${LOCATION_REQUIRED_MESSAGE} Add a confirmed map pin before publishing.`);
  const active = await db.$count(ticketTypes, and(eq(ticketTypes.eventId, event.id), eq(ticketTypes.isActive, true)));
  if (active === 0) throw new UserError("Add at least one ticket type before publishing.");
  await db.transaction(async (tx) => {
    await tx
      .update(events)
      .set({ status: "published", publishedAt: event.publishedAt ?? new Date(), updatedAt: new Date() })
      .where(eq(events.id, event.id));
    // First publication only (the dedupe key ignores later unpublish/republish cycles).
    await queueOrganizerEmail(tx, event.id, "organizer_event_published", { dedupeKey: `organizer_event_published:${event.id}` });
  });
  await audit(null, { actorUserId: ctx.user.id, action: "event.published", entityType: "event", entityId: event.id });
}

export async function unpublishEvent(event: Event, actor: User) {
  if (event.status !== "published") throw new UserError("Event isn't published.");
  await db.update(events).set({ status: "draft", updatedAt: new Date() }).where(eq(events.id, event.id));
  await audit(null, { actorUserId: actor.id, action: "event.unpublished", entityType: "event", entityId: event.id });
}

export const ticketTypeSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(60),
    description: z.string().trim().max(300).default(""),
    price: z.string().trim(),
    capacity: z.coerce.number().int("Whole number").min(1, "At least 1").max(200_000),
    maxPerOrder: z.coerce.number().int().min(1).max(50).default(10),
    salesStartLocal: z.string().optional().default(""),
    salesEndLocal: z.string().optional().default(""),
    timezone: z.string().default("Africa/Nairobi"),
  })
  .transform((v, ctx) => {
    const priceMinor = parseMajorToMinor(v.price === "" ? "0" : v.price);
    if (priceMinor === null) ctx.addIssue({ code: "custom", path: ["price"], message: "Enter a price in KES, e.g. 1500" });
    if (priceMinor !== null && priceMinor > 0 && priceMinor < 1000)
      ctx.addIssue({ code: "custom", path: ["price"], message: "Paid tickets must cost at least KES 10" });
    // M-Pesa charges whole shillings only.
    if (priceMinor !== null && priceMinor % 100 !== 0)
      ctx.addIssue({ code: "custom", path: ["price"], message: "Use a whole number of shillings, e.g. 1500" });
    const salesStartAt = v.salesStartLocal ? zonedLocalToUtc(v.salesStartLocal, v.timezone) : null;
    const salesEndAt = v.salesEndLocal ? zonedLocalToUtc(v.salesEndLocal, v.timezone) : null;
    if (salesStartAt && salesEndAt && salesEndAt <= salesStartAt)
      ctx.addIssue({ code: "custom", path: ["salesEndLocal"], message: "Sales end must be after sales start" });
    return { ...v, priceMinor: priceMinor ?? 0, salesStartAt, salesEndAt };
  });

/** Adds several ticket types at once (quick add). All are created, or none. */
export async function addTicketTypes(event: Event, actor: User, inputs: z.output<typeof ticketTypeSchema>[]) {
  if (event.status === "cancelled") throw new UserError("Cancelled events can't be edited.");
  if (!inputs.length) throw new UserError("Choose at least one ticket type.");
  return db.transaction(async (tx) => {
    // Serialize concurrent adds for this event so the 12-type cap holds.
    await tx.select({ id: events.id }).from(events).where(eq(events.id, event.id)).for("update");
    const existing = await tx.select({ name: ticketTypes.name }).from(ticketTypes).where(eq(ticketTypes.eventId, event.id));
    if (existing.length + inputs.length > 12) throw new UserError(`An event can have at most 12 ticket types (this event has ${existing.length}).`);
    const taken = new Set(existing.map((t) => t.name.trim().toLowerCase()));
    const dup = inputs.find((i) => taken.has(i.name.trim().toLowerCase()));
    if (dup) throw new UserError(`“${dup.name}” already exists on this event.`);
    const rows = await tx
      .insert(ticketTypes)
      .values(
        inputs.map((input, i) => ({
          eventId: event.id,
          name: input.name,
          description: input.description,
          priceMinor: input.priceMinor,
          capacity: input.capacity,
          maxPerOrder: input.maxPerOrder,
          salesStartAt: input.salesStartAt,
          salesEndAt: input.salesEndAt,
          sortOrder: existing.length + i,
        })),
      )
      .returning();
    for (const tt of rows) await audit(tx, { actorUserId: actor.id, action: "ticket_type.created", entityType: "ticket_type", entityId: tt.id });
    return rows;
  });
}

export async function upsertTicketType(event: Event, actor: User, input: z.output<typeof ticketTypeSchema>, id?: string) {
  if (event.status === "cancelled") throw new UserError("Cancelled events can't be edited.");
  if (id) {
    const [tt] = await db.select().from(ticketTypes).where(and(eq(ticketTypes.id, id), eq(ticketTypes.eventId, event.id)));
    if (!tt) throw new UserError("Ticket type not found.");
    if (input.capacity < tt.sold + tt.reserved) {
      throw new UserError(`Capacity can't be lower than ${tt.sold + tt.reserved} (already sold or reserved).`);
    }
    // Existing bookings keep their price snapshot; new price applies to new orders only.
    const rows = await db
      .update(ticketTypes)
      .set({
        name: input.name,
        description: input.description,
        priceMinor: input.priceMinor,
        capacity: input.capacity,
        maxPerOrder: input.maxPerOrder,
        salesStartAt: input.salesStartAt,
        salesEndAt: input.salesEndAt,
        updatedAt: new Date(),
      })
      .where(and(eq(ticketTypes.id, id), sql`${ticketTypes.sold} + ${ticketTypes.reserved} <= ${input.capacity}`))
      .returning();
    if (!rows.length) throw new UserError("Capacity is below tickets already sold or reserved.");
    await audit(null, { actorUserId: actor.id, action: "ticket_type.updated", entityType: "ticket_type", entityId: id, metadata: { priceMinor: input.priceMinor, capacity: input.capacity } });
    return rows[0];
  }
  const count = await db.$count(ticketTypes, eq(ticketTypes.eventId, event.id));
  if (count >= 12) throw new UserError("An event can have at most 12 ticket types.");
  const [tt] = await db
    .insert(ticketTypes)
    .values({
      eventId: event.id,
      name: input.name,
      description: input.description,
      priceMinor: input.priceMinor,
      capacity: input.capacity,
      maxPerOrder: input.maxPerOrder,
      salesStartAt: input.salesStartAt,
      salesEndAt: input.salesEndAt,
      sortOrder: count,
    })
    .returning();
  await audit(null, { actorUserId: actor.id, action: "ticket_type.created", entityType: "ticket_type", entityId: tt.id });
  return tt;
}

/** Deletes an unsold ticket type, or deactivates it if anything was ever booked. */
export async function removeTicketType(event: Event, actor: User, id: string) {
  const [tt] = await db.select().from(ticketTypes).where(and(eq(ticketTypes.id, id), eq(ticketTypes.eventId, event.id)));
  if (!tt) throw new UserError("Ticket type not found.");
  const used = await db.$count(bookingItems, eq(bookingItems.ticketTypeId, id));
  if (used > 0) {
    await db.update(ticketTypes).set({ isActive: false, updatedAt: new Date() }).where(eq(ticketTypes.id, id));
    await audit(null, { actorUserId: actor.id, action: "ticket_type.deactivated", entityType: "ticket_type", entityId: id });
    return "deactivated" as const;
  }
  await db.delete(ticketTypes).where(eq(ticketTypes.id, id));
  await audit(null, { actorUserId: actor.id, action: "ticket_type.deleted", entityType: "ticket_type", entityId: id });
  return "deleted" as const;
}

export async function setTicketTypeActive(event: Event, actor: User, id: string, active: boolean) {
  await db
    .update(ticketTypes)
    .set({ isActive: active, updatedAt: new Date() })
    .where(and(eq(ticketTypes.id, id), eq(ticketTypes.eventId, event.id)));
  await audit(null, { actorUserId: actor.id, action: active ? "ticket_type.activated" : "ticket_type.deactivated", entityType: "ticket_type", entityId: id });
}

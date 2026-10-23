import { and, asc, desc, eq, gt, gte, ilike, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { events, organizerProfiles, ticketTypes, type Event, type TicketType } from "@/db/schema";

export const CATEGORIES = [
  { value: "music", label: "Music" },
  { value: "festival", label: "Festivals" },
  { value: "nightlife", label: "Nightlife" },
  { value: "conference", label: "Conferences" },
  { value: "sports", label: "Sports" },
  { value: "workshop", label: "Workshops" },
  { value: "comedy", label: "Comedy" },
  { value: "arts", label: "Arts & Culture" },
] as const;
export type CategoryValue = (typeof CATEGORIES)[number]["value"];
export const isCategory = (v: unknown): v is CategoryValue => CATEGORIES.some((c) => c.value === v);
export const categoryLabel = (v: string) => CATEGORIES.find((c) => c.value === v)?.label ?? v;

/** SQL predicate for "publicly visible": published, not hidden, verified organizer. */
export function publicEventWhere(): SQL {
  return and(
    eq(events.status, "published"),
    eq(events.isHidden, false),
    eq(organizerProfiles.verificationStatus, "verified"),
  )!;
}

export type EventCard = {
  id: string;
  slug: string;
  title: string;
  category: string;
  coverImageUrl: string | null;
  venueName: string;
  venueAddress: string;
  city: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  minPriceMinor: number | null;
  available: number;
  isFeatured: boolean;
  organizerName: string;
};

const minPrice = sql<number | null>`(select min(${ticketTypes.priceMinor}) from ${ticketTypes} where ${ticketTypes.eventId} = ${events.id} and ${ticketTypes.isActive})`.mapWith(
  (v) => (v === null ? null : Number(v)),
);
const available = sql<number>`coalesce((select sum(${ticketTypes.capacity} - ${ticketTypes.sold} - ${ticketTypes.reserved}) from ${ticketTypes} where ${ticketTypes.eventId} = ${events.id} and ${ticketTypes.isActive}), 0)`.mapWith(
  Number,
);

const cardColumns = {
  id: events.id,
  slug: events.slug,
  title: events.title,
  category: events.category,
  coverImageUrl: events.coverImageUrl,
  venueName: events.venueName,
  venueAddress: events.venueAddress,
  city: events.city,
  startsAt: events.startsAt,
  endsAt: events.endsAt,
  timezone: events.timezone,
  isFeatured: events.isFeatured,
  organizerName: organizerProfiles.displayName,
  minPriceMinor: minPrice,
  available,
};

export type EventSearch = {
  q?: string;
  category?: string;
  city?: string;
  when?: "today" | "weekend" | "week" | "month" | "";
  date?: string; // YYYY-MM-DD
  featured?: boolean;
  limit?: number;
};

export function nairobiDayBounds(dateStr: string) {
  // Africa/Nairobi is UTC+3 year-round.
  const start = new Date(`${dateStr}T00:00:00+03:00`);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function whenRange(when: EventSearch["when"], now = new Date()): { start: Date; end: Date } | null {
  const todayStr = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Nairobi" }).format(now);
  const { start: today } = nairobiDayBounds(todayStr);
  const day = 86_400_000;
  switch (when) {
    case "today":
      return { start: now, end: new Date(today.getTime() + day) };
    case "weekend": {
      const dow = new Date(today.getTime() + 3 * 3600_000).getUTCDay(); // 0=Sun
      const toFri = (5 - dow + 7) % 7;
      const fri = new Date(today.getTime() + (dow === 0 ? -2 : dow === 6 ? -1 : toFri) * day);
      return { start: new Date(Math.max(fri.getTime(), now.getTime())), end: new Date(fri.getTime() + 3 * day) };
    }
    case "week":
      return { start: now, end: new Date(today.getTime() + 7 * day) };
    case "month":
      return { start: now, end: new Date(today.getTime() + 31 * day) };
    default:
      return null;
  }
}

/** The window an events search covers: a picked date wins over a "when" preset. */
export function searchDateRange(s: Pick<EventSearch, "when" | "date">) {
  return s.date && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? nairobiDayBounds(s.date) : whenRange(s.when);
}

export async function searchPublicEvents(s: EventSearch = {}): Promise<EventCard[]> {
  const now = new Date();
  const conds: SQL[] = [publicEventWhere(), gt(events.endsAt, now)];
  if (s.q?.trim()) {
    const term = `%${s.q.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(
      or(
        ilike(events.title, term),
        ilike(events.venueName, term),
        ilike(events.city, term),
        ilike(organizerProfiles.displayName, term),
        ilike(events.summary, term),
      )!,
    );
  }
  if (s.category && isCategory(s.category)) conds.push(eq(events.category, s.category));
  if (s.city?.trim()) conds.push(ilike(events.city, s.city.trim()));
  const r = searchDateRange(s);
  if (r) conds.push(lt(events.startsAt, r.end), gt(events.endsAt, r.start));
  if (s.featured) conds.push(eq(events.isFeatured, true));

  return db
    .select(cardColumns)
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(and(...conds))
    .orderBy(asc(events.startsAt))
    .limit(Math.min(s.limit ?? 48, 100));
}

export async function publicCities(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ city: events.city })
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(and(publicEventWhere(), gt(events.endsAt, new Date())))
    .orderBy(asc(events.city));
  return rows.map((r) => r.city);
}

export type PublicEventDetail = {
  event: Event;
  organizer: { id: string; displayName: string; slug: string; bio: string | null; city: string | null };
  ticketTypes: (TicketType & { remaining: number; onSale: boolean; saleState: "on_sale" | "upcoming" | "ended" | "sold_out" })[];
};

export function decorateTypes(types: TicketType[], now = new Date()) {
  return types.map((t) => {
    const remaining = Math.max(0, t.capacity - t.sold - t.reserved);
    const saleState: "on_sale" | "upcoming" | "ended" | "sold_out" =
      t.salesStartAt && t.salesStartAt > now
        ? "upcoming"
        : t.salesEndAt && t.salesEndAt <= now
          ? "ended"
          : remaining === 0
            ? "sold_out"
            : "on_sale";
    return { ...t, remaining, saleState, onSale: saleState === "on_sale" };
  });
}

async function eventDetail(where: SQL): Promise<PublicEventDetail | null> {
  const [row] = await db
    .select({ event: events, organizer: organizerProfiles })
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(where);
  if (!row) return null;
  const types = await db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, row.event.id), eq(ticketTypes.isActive, true)))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.priceMinor));
  return {
    event: row.event,
    organizer: {
      id: row.organizer.id,
      displayName: row.organizer.displayName,
      slug: row.organizer.slug,
      bio: row.organizer.bio,
      city: row.organizer.city,
    },
    ticketTypes: decorateTypes(types),
  };
}

/** Public detail: only published, unhidden events of verified organizers. Cancelled events stay viewable (with a banner) to buyers. */
export async function getPublicEvent(slug: string) {
  return eventDetail(
    and(
      eq(events.slug, slug),
      eq(events.isHidden, false),
      eq(organizerProfiles.verificationStatus, "verified"),
      inArray(events.status, ["published", "cancelled"]),
    )!,
  );
}

/** Preview for the owning organizer / admin (any status). Authorization is the caller's job. */
export async function getEventPreview(eventId: string) {
  return eventDetail(eq(events.id, eventId));
}

export async function organizerEvents(organizerId: string) {
  return db
    .select({
      ...cardColumns,
      status: events.status,
      isHidden: events.isHidden,
      sold: sql<number>`coalesce((select sum(${ticketTypes.sold}) from ${ticketTypes} where ${ticketTypes.eventId} = ${events.id}), 0)`.mapWith(Number),
      capacity: sql<number>`coalesce((select sum(${ticketTypes.capacity}) from ${ticketTypes} where ${ticketTypes.eventId} = ${events.id}), 0)`.mapWith(Number),
    })
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(events.organizerId, organizerId))
    .orderBy(desc(gte(events.endsAt, new Date())), asc(events.startsAt));
}

export async function ticketTypesForEvent(eventId: string) {
  const rows = await db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(asc(ticketTypes.sortOrder), asc(ticketTypes.priceMinor));
  return decorateTypes(rows);
}

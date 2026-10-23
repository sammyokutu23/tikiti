/**
 * The Buy page: every ticket for an event in one place (the organizer's ticket
 * types and fans' resale listings), filterable by ticket type and price.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { ticketTypes } from "@/db/schema";
import { marketplaceListings } from "../resale/listings";
import { resaleTotalMinor } from "../resale/policy";
import { decorateTypes, searchPublicEvents, type EventSearch } from "./queries";

/** Ticket-type filter: a keyword family, since organizers name tiers freely ("VIP Booth", "VIP 2-Day"…). */
export const TICKET_KINDS = [
  { value: "regular", label: "Regular", match: /regular|general|standard|\bga\b|admission/i },
  { value: "vip", label: "VIP", match: /\bvip\b/i },
  { value: "vvip", label: "VVIP", match: /vvip/i },
  { value: "early", label: "Early bird", match: /early/i },
  { value: "student", label: "Student", match: /student/i },
  { value: "group", label: "Group & couples", match: /couple|group|pax|table|duo/i },
] as const;
export type TicketKind = (typeof TICKET_KINDS)[number]["value"];
export const isTicketKind = (v: unknown): v is TicketKind => TICKET_KINDS.some((k) => k.value === v);

export type BuyOption =
  | { kind: "primary"; id: string; name: string; priceMinor: number; state: "on_sale" | "upcoming" | "sold_out"; remaining: number; href: string }
  | { kind: "resale"; id: string; name: string; priceMinor: number; trust: "platform" | "external"; href: string };

export type BuyEvent = {
  id: string;
  slug: string;
  title: string;
  category: string;
  coverImageUrl: string | null;
  venueName: string;
  city: string;
  startsAt: Date;
  timezone: string;
  isExternal: boolean;
  href: string;
  options: BuyOption[];
};

export type BuyFilters = Pick<EventSearch, "q" | "category" | "city" | "when" | "date"> & { type?: TicketKind; minKes?: number; maxKes?: number };

export async function buyCatalog(f: BuyFilters): Promise<BuyEvent[]> {
  const search = { q: f.q, category: f.category, city: f.city, when: f.when, date: f.date };
  const [primary, resale] = await Promise.all([searchPublicEvents({ ...search, limit: 100 }), marketplaceListings(search)]);

  const types = primary.length
    ? decorateTypes(
        await db
          .select()
          .from(ticketTypes)
          .where(and(inArray(ticketTypes.eventId, primary.map((e) => e.id)), eq(ticketTypes.isActive, true)))
          .orderBy(asc(ticketTypes.sortOrder)),
      )
    : [];

  const byId = new Map<string, BuyEvent>();
  for (const e of primary) {
    byId.set(e.id, {
      id: e.id,
      slug: e.slug,
      title: e.title,
      category: e.category,
      coverImageUrl: e.coverImageUrl,
      venueName: e.venueName,
      city: e.city,
      startsAt: e.startsAt,
      timezone: e.timezone,
      isExternal: false,
      href: `/events/${e.slug}`,
      options: [],
    });
  }
  for (const t of types) {
    if (t.saleState === "ended") continue;
    const ev = byId.get(t.eventId)!;
    ev.options.push({ kind: "primary", id: t.id, name: t.name, priceMinor: t.priceMinor, state: t.saleState, remaining: t.remaining, href: ev.href });
  }
  // Outside events (resale only) aren't in the public event list; their listings bring them in.
  for (const { listing, event } of resale) {
    let ev = byId.get(event.id);
    if (!ev) {
      ev = {
        id: event.id,
        slug: event.slug,
        title: event.title,
        category: event.category,
        coverImageUrl: event.coverImageUrl,
        venueName: event.venueName,
        city: event.city,
        startsAt: event.startsAt,
        timezone: event.timezone,
        isExternal: event.isExternal,
        href: `/resale/${listing.reference}`,
        options: [],
      };
      byId.set(event.id, ev);
    }
    ev.options.push({ kind: "resale", id: listing.id, name: listing.ticketTypeName, priceMinor: resaleTotalMinor(listing.priceMinor), trust: listing.kind, href: `/resale/${listing.reference}` });
  }

  const kind = f.type ? TICKET_KINDS.find((k) => k.value === f.type) : undefined;
  const min = f.minKes !== undefined ? f.minKes * 100 : null;
  const max = f.maxKes !== undefined ? f.maxKes * 100 : null;
  const optionFilter = kind || min !== null || max !== null;
  const matches = (o: BuyOption) => (!kind || kind.match.test(o.name)) && (min === null || o.priceMinor >= min) && (max === null || o.priceMinor <= max);

  return [...byId.values()]
    .map((ev) => ({ ...ev, options: ev.options.filter(matches).sort((a, b) => a.priceMinor - b.priceMinor) }))
    .filter((ev) => !optionFilter || ev.options.length > 0)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

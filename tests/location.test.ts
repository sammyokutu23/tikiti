import { eq } from "drizzle-orm";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { events, tickets } from "@/db/schema";
import { directionsUrl, eventCoordinates, isValidLatLng, mapsSearchUrl } from "@/lib/location";
import { createEvent, eventFormSchema, publishEvent, updateEvent } from "@/server/events/mutations";
import { GeocoderUnavailableError, _clearGeocodeCache, normalizeNominatim, searchVenues, type NominatimItem } from "@/server/geocoding";
import { processDueJobs } from "@/server/jobs/queue";
import { renderBookingPdf } from "@/server/tickets/documents";
import { buyTickets, makeEvent, makeOrganizer, resetDb, customerEmails } from "./helpers";

const base = {
  title: "Location Test Night",
  summary: "",
  description: "A long enough description for validation.",
  category: "music",
  venueName: "KICC",
  venueAddress: "Harambee Avenue",
  city: "Nairobi",
  timezone: "Africa/Nairobi",
  startsLocal: "2026-12-01T18:00",
  endsLocal: "2026-12-01T22:00",
  refundPolicy: "Full refund if cancelled.",
};
const pin = { latitude: "-1.288682", longitude: "36.823606", locationConfirmed: "1", locationProvider: "nominatim", locationPlaceId: "osm:node:5555074079" };

function linkUris(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      const action = a.lookupMaybe(PDFName.of("A"), PDFDict);
      const uri = action?.lookupMaybe(PDFName.of("URI"), PDFString);
      if (uri) out.push(uri.decodeText());
    }
  }
  return out;
}

describe("location helpers", () => {
  it("validates coordinate ranges and rejects 0,0", () => {
    expect(isValidLatLng(-1.2886, 36.8236)).toBe(true);
    expect(isValidLatLng(91, 36)).toBe(false);
    expect(isValidLatLng(-1, 181)).toBe(false);
    expect(isValidLatLng(0, 0)).toBe(false);
    expect(isValidLatLng(NaN, 1)).toBe(false);
    expect(eventCoordinates({ latitude: null, longitude: null })).toBeNull();
  });
  it("builds a Google Maps directions URL to the exact pin", () => {
    expect(directionsUrl({ lat: -1.2886818, lng: 36.8236064 })).toBe("https://www.google.com/maps/dir/?api=1&destination=-1.288682,36.823606");
    expect(mapsSearchUrl(["KICC", "", "Nairobi"])).toContain("query=KICC%2C%20Nairobi");
  });
});

describe("event form location validation", () => {
  it("accepts a confirmed pin and rounds to 6 decimals", () => {
    const r = eventFormSchema.safeParse({ ...base, ...pin, latitude: "-1.28868181234" });
    expect(r.success).toBe(true);
    expect(r.data!.location).toEqual({ lat: -1.288682, lng: 36.823606, provider: "nominatim", placeId: "osm:node:5555074079" });
  });
  it("rejects unconfirmed, half-filled and out-of-range pins", () => {
    const err = (extra: object) => {
      const r = eventFormSchema.safeParse({ ...base, ...pin, ...extra });
      return r.success ? null : r.error.issues.find((i) => i.path[0] === "location")?.message;
    };
    expect(err({ locationConfirmed: "" })).toMatch(/Confirm the pin/);
    expect(err({ longitude: "" })).toMatch(/invalid/);
    expect(err({ latitude: "95" })).toMatch(/invalid/);
    expect(err({ latitude: "abc" })).toMatch(/invalid/);
  });
  it("treats an absent pin as null (decided per action)", () => {
    const r = eventFormSchema.safeParse(base);
    expect(r.success && r.data.location).toBeNull();
  });
  it("database rejects out-of-range or half coordinates", async () => {
    await resetDb();
    const { organizer } = await makeOrganizer();
    const { event } = await makeEvent(organizer.id);
    await expect(db.update(events).set({ latitude: 95 }).where(eq(events.id, event.id))).rejects.toThrow();
    await expect(db.update(events).set({ longitude: null }).where(eq(events.id, event.id))).rejects.toThrow();
  });
});

describe("saving locations", () => {
  beforeEach(resetDb);

  it("requires a pin to create and to publish; legacy events stay editable", async () => {
    const ctx = await makeOrganizer();
    const noPin = eventFormSchema.parse(base);
    await expect(createEvent(ctx, noPin, null)).rejects.toThrow(/map/);

    const created = await createEvent(ctx, eventFormSchema.parse({ ...base, ...pin }), null);
    const [reloaded] = await db.select().from(events).where(eq(events.id, created.id));
    expect([reloaded.latitude, reloaded.longitude]).toEqual([-1.288682, 36.823606]);
    expect(reloaded.locationProvider).toBe("nominatim");
    expect(reloaded.locationConfirmedAt).toBeInstanceOf(Date);

    // A legacy event without coordinates: editable, but not publishable.
    const { event: legacy } = await makeEvent(ctx.organizer.id, undefined, null);
    await db.update(events).set({ status: "draft" }).where(eq(events.id, legacy.id));
    const [lg] = await db.select().from(events).where(eq(events.id, legacy.id));
    await expect(updateEvent(lg, ctx.user, noPin, null)).resolves.toBeTruthy();
    await expect(publishEvent(lg, ctx)).rejects.toThrow(/map pin/);
  });

  it("moving the pin preserves other fields, ticket codes, and can't remove the pin", async () => {
    const ctx = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(ctx.organizer.id);
    const b = await buyTickets(event.id, [[tt.id, 2]]);
    const codesBefore = (await db.select().from(tickets).where(eq(tickets.bookingId, b.id))).map((t) => t.code).sort();

    const input = eventFormSchema.parse({
      ...base,
      title: event.title,
      description: event.description,
      venueName: event.venueName,
      city: event.city,
      latitude: "-1.3",
      longitude: "36.8",
      locationConfirmed: "1",
      locationProvider: "manual",
      arrivalInstructions: "Use Gate B",
    });
    await updateEvent(event, ctx.user, input, event.coverImageUrl);
    const [after] = await db.select().from(events).where(eq(events.id, event.id));
    expect([after.latitude, after.longitude, after.locationProvider, after.locationPlaceId]).toEqual([-1.3, 36.8, "manual", null]);
    expect(after.arrivalInstructions).toBe("Use Gate B");
    expect(after.status).toBe(event.status);
    expect(after.slug).toBe(event.slug);
    const codesAfter = (await db.select().from(tickets).where(eq(tickets.bookingId, b.id))).map((t) => t.code).sort();
    expect(codesAfter).toEqual(codesBefore);

    await expect(updateEvent(after, ctx.user, eventFormSchema.parse({ ...base, title: event.title }), null)).rejects.toThrow(/map/);
  });
});

describe("tickets & email carry the venue location", () => {
  beforeEach(resetDb);

  it("PDF has a clickable directions link to the saved pin", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, undefined, { lat: -1.32842, lng: 36.80402 });
    const b = await buyTickets(event.id, [[tt.id, 2]]);
    const doc = await PDFDocument.load((await renderBookingPdf(b.id)).bytes);
    const uris = linkUris(doc);
    expect(uris).toHaveLength(2); // one per ticket page
    expect(new Set(uris)).toEqual(new Set(["https://www.google.com/maps/dir/?api=1&destination=-1.32842,36.80402"]));
  });

  it("PDF for an event without a pin has no directions link", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, undefined, null);
    const b = await buyTickets(event.id, [[tt.id, 1]]);
    expect(linkUris(await PDFDocument.load((await renderBookingPdf(b.id)).bytes))).toEqual([]);
  });

  it("confirmation email includes venue address, directions and arrival info", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, undefined, { lat: -1.32842, lng: 36.80402 });
    await db.update(events).set({ venueAddress: "Langata Road", arrivalInstructions: "Gate B & parking" }).where(eq(events.id, event.id));
    await buyTickets(event.id, [[tt.id, 1]]);
    await processDueJobs();
    const mail = customerEmails().at(-1)!;
    expect(mail.html).toContain("https://www.google.com/maps/dir/?api=1&amp;destination=-1.32842,36.80402");
    expect(mail.html).toContain("Test Venue, Langata Road, Nairobi");
    expect(mail.html).toContain("Gate B &amp; parking");
    expect(mail.text).toContain("Directions: https://www.google.com/maps/dir/?api=1&destination=-1.32842,36.80402");
    expect(linkUris(await PDFDocument.load(mail.attachments![0].content))).toHaveLength(1);
  });

  it("email for an event without a pin has no directions link", async () => {
    const { organizer } = await makeOrganizer();
    const { event, ticketTypes: [tt] } = await makeEvent(organizer.id, undefined, null);
    await buyTickets(event.id, [[tt.id, 1]]);
    await processDueJobs();
    expect(customerEmails().at(-1)!.html).not.toContain("maps/dir");
  });
});

describe("geocoding (Nominatim adapter)", () => {
  const sample: NominatimItem[] = [
    {
      place_id: 1,
      osm_type: "node",
      osm_id: 5555074079,
      lat: "-1.2886818",
      lon: "36.8236064",
      name: "Kenyatta International Convention Centre",
      display_name: "Kenyatta International Convention Centre, Harambee Avenue, Nairobi Central, Nairobi, Kenya",
      type: "conference_centre",
      address: { road: "Harambee Avenue", suburb: "Nairobi Central", city: "Nairobi", country: "Kenya" },
    },
    { place_id: 2, lat: "0", lon: "0", display_name: "Bad", address: {} },
  ];

  it("normalizes results and drops invalid coordinates", () => {
    const r = normalizeNominatim(sample);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "osm:node:5555074079", name: "Kenyatta International Convention Centre", address: "Harambee Avenue, Nairobi Central", city: "Nairobi", lat: -1.288682, lng: 36.823606 });
  });

  it("biases to Kenya, identifies itself, caches, and surfaces errors", async () => {
    _clearGeocodeCache();
    const calls: { url: string; ua: string }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), ua: String((init.headers as Record<string, string>)["User-Agent"]) });
      return new Response(JSON.stringify(sample), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await searchVenues("KICC Nairobi", fake);
    expect(r[0].city).toBe("Nairobi");
    expect(calls[0].url).toContain("countrycodes=ke");
    expect(calls[0].ua).toMatch(/^TikoSokoTicketing/);
    await searchVenues("  kicc   nairobi ", fake);
    expect(calls).toHaveLength(1); // cached
    expect(await searchVenues("ab", fake)).toEqual([]);

    const failing = (async () => new Response("busy", { status: 429 })) as unknown as typeof fetch;
    await expect(searchVenues("Uhuru Gardens", failing)).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });
});

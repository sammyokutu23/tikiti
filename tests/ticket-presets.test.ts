/** Quick-add ticket types: several common types created at once, all or nothing. */
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { ticketTypes } from "@/db/schema";
import { TICKET_PRESETS } from "@/lib/ticket-presets";
import { addTicketTypes, ticketTypeSchema } from "@/server/events/mutations";
import { makeEvent, makeOrganizer, resetDb } from "./helpers";

const input = (name: string, price: string, capacity = "50") => ticketTypeSchema.parse({ name, price, capacity });

describe("quick-add ticket types", () => {
  beforeEach(resetDb);

  it("presets have unique keys and valid defaults", () => {
    expect(new Set(TICKET_PRESETS.map((p) => p.key)).size).toBe(TICKET_PRESETS.length);
    for (const p of TICKET_PRESETS) expect(ticketTypeSchema.safeParse({ name: p.name, description: p.description, price: "free" in p ? "0" : "1500", capacity: String(p.capacity) }).success).toBe(true);
  });

  it("adds several types in order after the existing ones", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event } = await makeEvent(organizer.id);
    await addTicketTypes(event, user, [input("Early Bird", "800"), input("VIP", "3000", "20"), input("Free entry", "0")]);
    const rows = await db.select().from(ticketTypes).where(eq(ticketTypes.eventId, event.id)).orderBy(asc(ticketTypes.sortOrder));
    expect(rows.map((r) => [r.name, r.priceMinor, r.capacity, r.sortOrder])).toEqual([
      ["Regular", 100000, 100, 0],
      ["Early Bird", 80000, 50, 1],
      ["VIP", 300000, 20, 2],
      ["Free entry", 0, 50, 3],
    ]);
  });

  it("creates nothing when a name already exists or the cap would be exceeded", async () => {
    const { user, organizer } = await makeOrganizer();
    const { event } = await makeEvent(organizer.id);
    await expect(addTicketTypes(event, user, [input("VIP", "3000"), input("regular", "1000")])).rejects.toThrow(/already exists/);
    const many = Array.from({ length: 12 }, (_, i) => input(`Type ${i}`, "100"));
    await expect(addTicketTypes(event, user, many)).rejects.toThrow(/at most 12/);
    expect(await db.$count(ticketTypes, eq(ticketTypes.eventId, event.id))).toBe(1);
  });
});

/** Non-destructive: adds demo pins to seeded events that have none. Dev only. */
import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { events } from "@/db/schema";
import { DEMO_LOCATIONS } from "./demo-locations";

(async () => {
  if (process.env.NODE_ENV === "production") throw new Error("dev only");
  let n = 0;
  for (const [slug, l] of Object.entries(DEMO_LOCATIONS)) {
    const r = await db
      .update(events)
      .set({ latitude: l.lat, longitude: l.lng, locationProvider: "manual", locationConfirmedAt: new Date(), arrivalInstructions: l.arrival ?? "" })
      .where(and(eq(events.slug, slug), isNull(events.latitude)))
      .returning({ id: events.id });
    n += r.length;
  }
  console.log(`Backfilled ${n} demo event location(s).`);
  await closeDb();
})();

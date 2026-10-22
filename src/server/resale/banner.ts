/**
 * AI cover banners for outside events (created when an admin approves a ticket
 * bought on another platform). Those events have no organizer to upload a
 * cover, so the AI Banner Studio makes one: same provider, limits and overlay,
 * with the style picked from the event's category.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events, type User } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { generateEventBanners, saveBannerAsCover } from "../banners/service";
import { generateBannerSchema, type BannerStyle } from "../banners/prompt";

const STYLE_FOR_CATEGORY: Record<string, BannerStyle> = {
  music: "music_concert",
  festival: "festival_outdoor",
  nightlife: "premium_nightlife",
  conference: "corporate",
  sports: "bold_energetic",
  workshop: "minimal_elegant",
  comedy: "bold_energetic",
  arts: "afro_tropical",
};

/**
 * Generates one landscape banner and makes it the cover of an outside event.
 * Returns false (and spends nothing) when the event already has a cover or
 * isn't an outside event: organizers' own events are never touched.
 */
export async function ensureOutsideEventBanner(eventId: string, actor: User): Promise<boolean> {
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) throw new UserError("Event not found.");
  if (!event.isExternal || event.coverImageUrl) return false;
  const input = generateBannerSchema.parse({
    style: STYLE_FOR_CATEGORY[event.category] ?? "bold_energetic",
    format: "landscape",
    category: event.category,
    // The title stays out of the prompt (see buildBannerPrompt); the overlay adds it exactly.
    brief: `Held at ${event.venueName}, ${event.city}, Kenya.`,
    count: 1,
  });
  const generation = await generateEventBanners({ actor, event, input });
  await saveBannerAsCover({
    actor,
    event,
    generationId: generation.id,
    index: 0,
    opts: { showText: true, showDate: true, showVenue: true, showCta: false, showOrganizer: false },
    confirmReplace: false,
  });
  return true;
}

/**
 * AI Event Banner Studio: usage-limited generation, storage of the artwork and
 * saving a composed banner as an event cover.
 *
 * Cost controls (configurable by admins, see bannerLimits()):
 *  - per-organizer images per 24 h and per 30 days, a platform-wide 30-day cap,
 *    a per-request image cap and a per-user request rate limit;
 *  - one generation in flight per organizer (unique index), so repeated clicks
 *    can't start parallel billed requests;
 *  - quota checks and the reservation run under one advisory lock, so concurrent
 *    requests can't both slip under a limit;
 *  - failed requests (no image produced) don't count toward an organizer's limits.
 */
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bannerGenerations, events, organizerProfiles, platformSettings, type BannerGeneration, type Event, type User } from "@/db/schema";
import { isUniqueViolation, UserError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "../audit";
import { loadImageBytes, storage } from "../storage";
import { composeBanner, normalizeBackground, type BannerOverlay } from "./compose";
import { BannerConfigError, BannerGenerationError, endUserId, generateImages, imageApiConfig } from "./openai";
import { BANNER_FORMATS, buildBannerPrompt, type BannerFormat, type GenerateBannerInput } from "./prompt";

// ─── Limits ──────────────────────────────────────────────────────────────────

export const bannerLimitsSchema = z.object({
  enabled: z.boolean(),
  imagesPerOrganizerPerDay: z.number().int().min(0).max(500),
  imagesPerOrganizerPerMonth: z.number().int().min(0).max(5000),
  imagesPlatformPerMonth: z.number().int().min(0).max(100_000),
  maxImagesPerRequest: z.number().int().min(1).max(4),
  requestsPerUserPerMinute: z.number().int().min(1).max(30),
});
export type BannerLimits = z.infer<typeof bannerLimitsSchema>;

export const DEFAULT_BANNER_LIMITS: BannerLimits = {
  enabled: true,
  imagesPerOrganizerPerDay: 6,
  imagesPerOrganizerPerMonth: 40,
  imagesPlatformPerMonth: 500,
  maxImagesPerRequest: 2,
  requestsPerUserPerMinute: 3,
};
const LIMITS_KEY = "ai_banner_limits";

export async function bannerLimits(): Promise<BannerLimits> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, LIMITS_KEY));
  const parsed = bannerLimitsSchema.safeParse({ ...DEFAULT_BANNER_LIMITS, ...((row?.value as object) ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_BANNER_LIMITS;
}

export async function setBannerLimits(limits: BannerLimits, actor: User) {
  const value = bannerLimitsSchema.parse(limits);
  await db.transaction(async (tx) => {
    await tx
      .insert(platformSettings)
      .values({ key: LIMITS_KEY, value, updatedBy: actor.id })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: actor.id, updatedAt: new Date() } });
    await audit(tx, { actorUserId: actor.id, action: "settings.ai_banner_limits_updated", entityType: "platform_setting", entityId: LIMITS_KEY, metadata: value });
  });
}

const DAY = 86_400_000;
/** A pending row older than this is a crashed/abandoned request. */
const STALE_PENDING_MS = 6 * 60_000;

const countedImages = (where: ReturnType<typeof and>) =>
  db
    .select({ n: sql<number>`coalesce(sum(${bannerGenerations.imageCount}), 0)::int` })
    .from(bannerGenerations)
    .where(and(inArray(bannerGenerations.status, ["pending", "succeeded"]), where))
    .then((r) => r[0]?.n ?? 0);

export async function bannerUsage(organizerId: string | null, now = new Date()) {
  const [orgDay, orgMonth, platformMonth] = await Promise.all([
    organizerId ? countedImages(and(eq(bannerGenerations.organizerId, organizerId), gte(bannerGenerations.createdAt, new Date(now.getTime() - DAY)))) : 0,
    organizerId ? countedImages(and(eq(bannerGenerations.organizerId, organizerId), gte(bannerGenerations.createdAt, new Date(now.getTime() - 30 * DAY)))) : 0,
    countedImages(and(gte(bannerGenerations.createdAt, new Date(now.getTime() - 30 * DAY)))),
  ]);
  return { orgDay, orgMonth, platformMonth };
}

// ─── Generation ──────────────────────────────────────────────────────────────

export async function generateEventBanners(args: { actor: User; event: Event; input: GenerateBannerInput; now?: Date }): Promise<BannerGeneration> {
  const { actor, event, input } = args;
  if (event.status === "cancelled") throw new UserError("Cancelled events can't get new artwork.");
  let cfg;
  try {
    cfg = imageApiConfig();
  } catch (err) {
    if (err instanceof BannerConfigError) console.error("[banners] not configured:", err.message);
    throw new UserError("AI banners aren't available right now. You can still upload your own image.", "ai_unavailable", 503);
  }
  const limits = await bannerLimits();
  if (!limits.enabled) throw new UserError("AI banners are switched off by the platform administrator.", "ai_disabled", 403);
  const count = Math.min(input.count, limits.maxImagesPerRequest);
  if (!rateLimit(`banner:${actor.id}`, limits.requestsPerUserPerMinute, 60_000).ok) {
    throw new UserError("You're generating too quickly. Please wait a minute.", "rate_limited", 429);
  }
  const format = BANNER_FORMATS[input.format];
  const organizerId = event.organizerId;
  const now = args.now ?? new Date();

  let generation: BannerGeneration;
  try {
    generation = await db.transaction(async (tx) => {
      // Serialises quota checks so concurrent requests can't both pass a limit.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tikosoko:banner_quota'))`);
      await tx
        .update(bannerGenerations)
        .set({ status: "failed", errorCategory: "abandoned", errorMessage: "Request did not finish", completedAt: now })
        .where(and(eq(bannerGenerations.status, "pending"), lt(bannerGenerations.createdAt, new Date(now.getTime() - STALE_PENDING_MS))));
      const usage = await bannerUsage(organizerId, now);
      if (usage.orgDay + count > limits.imagesPerOrganizerPerDay) {
        const left = Math.max(0, limits.imagesPerOrganizerPerDay - usage.orgDay);
        throw new UserError(left > 0 ? `You can generate ${left} more image${left === 1 ? "" : "s"} in the next 24 hours.` : "You've reached today's AI banner limit. Try again tomorrow or upload your own image.", "limit_reached", 429);
      }
      if (usage.orgMonth + count > limits.imagesPerOrganizerPerMonth) {
        throw new UserError("You've reached your AI banner limit for this month. You can still upload your own image.", "limit_reached", 429);
      }
      if (usage.platformMonth + count > limits.imagesPlatformPerMonth) {
        throw new UserError("AI banners have reached the platform's monthly limit. Please upload your own image for now.", "limit_reached", 429);
      }
      const [row] = await tx
        .insert(bannerGenerations)
        .values({
          organizerId,
          eventId: event.id,
          userId: actor.id,
          model: cfg.model,
          style: input.style,
          format: input.format,
          size: format.generateSize,
          quality: cfg.quality,
          imageCount: count,
          brief: input.brief,
        })
        .returning();
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new UserError("A banner is already being generated for your account. Please wait for it to finish.", "in_progress", 409);
    throw err;
  }

  const fail = async (category: string, message: string) => {
    await db
      .update(bannerGenerations)
      .set({ status: "failed", errorCategory: category, errorMessage: message.slice(0, 300), completedAt: new Date() })
      .where(eq(bannerGenerations.id, generation.id));
    await audit(null, { actorUserId: actor.id, action: "banner.failed", entityType: "event", entityId: event.id, metadata: { generationId: generation.id, category } });
  };

  let images;
  try {
    images = await generateImages(cfg, { prompt: buildBannerPrompt(input), size: format.generateSize, n: count, endUser: endUserId(organizerId) });
  } catch (err) {
    const e = err instanceof BannerGenerationError ? err : new BannerGenerationError(String(err), "provider_unavailable", "Something went wrong while generating. Please try again.", true);
    console.warn(`[banners] generation ${generation.id} failed: ${e.category}`);
    await fail(e.category, e.userMessage);
    throw new UserError(e.userMessage, `ai_${e.category}`, e.category === "rate_limited" ? 429 : 502);
  }

  const urls: string[] = [];
  try {
    for (const img of images) {
      const norm = await normalizeBackground(img.bytes);
      urls.push(await storage().put(norm.bytes, { ext: "jpg", mime: "image/jpeg" }, `banners/${event.id}`));
    }
  } catch (err) {
    console.error(`[banners] storing generation ${generation.id} failed:`, (err as Error).message);
    await fail("storage", "The artwork was generated but couldn't be saved");
    throw new UserError("The artwork was generated but couldn't be saved. Please try again.", "ai_storage", 502);
  }

  const [done] = await db
    .update(bannerGenerations)
    .set({ status: "succeeded", imageUrls: urls, imageCount: urls.length, completedAt: new Date() })
    .where(eq(bannerGenerations.id, generation.id))
    .returning();
  await audit(null, {
    actorUserId: actor.id,
    action: "banner.generated",
    entityType: "event",
    entityId: event.id,
    metadata: { generationId: done.id, images: urls.length, model: done.model, style: done.style, format: done.format },
  });
  return done;
}

/** Admin overview: recent requests, top organizers and failures over the last 30 days. */
export async function bannerAdminOverview() {
  const since = new Date(Date.now() - 30 * DAY);
  const [recent, byOrganizer, failures] = await Promise.all([
    db
      .select({ g: bannerGenerations, event: events.title, organizer: organizerProfiles.displayName })
      .from(bannerGenerations)
      .innerJoin(events, eq(events.id, bannerGenerations.eventId))
      .innerJoin(organizerProfiles, eq(organizerProfiles.id, bannerGenerations.organizerId))
      .orderBy(desc(bannerGenerations.createdAt))
      .limit(40),
    db
      .select({
        organizer: organizerProfiles.displayName,
        images: sql<number>`coalesce(sum(${bannerGenerations.imageCount}) filter (where ${bannerGenerations.status} = 'succeeded'), 0)::int`,
        requests: sql<number>`count(*)::int`,
      })
      .from(bannerGenerations)
      .innerJoin(organizerProfiles, eq(organizerProfiles.id, bannerGenerations.organizerId))
      .where(gte(bannerGenerations.createdAt, since))
      .groupBy(organizerProfiles.displayName)
      .orderBy(desc(sql`count(*)`))
      .limit(10),
    db.$count(bannerGenerations, and(eq(bannerGenerations.status, "failed"), gte(bannerGenerations.createdAt, since))),
  ]);
  return { recent, byOrganizer, failures };
}

export async function eventGenerations(eventId: string, limit = 12) {
  return db.select().from(bannerGenerations).where(eq(bannerGenerations.eventId, eventId)).orderBy(desc(bannerGenerations.createdAt)).limit(limit);
}

// ─── Composition & saving ────────────────────────────────────────────────────

export const overlayOptionsSchema = z.object({
  showText: z.boolean().default(true),
  showDate: z.boolean().default(true),
  showVenue: z.boolean().default(true),
  showCta: z.boolean().default(false),
  showOrganizer: z.boolean().default(false),
});
export type OverlayOptions = z.infer<typeof overlayOptionsSchema>;

/** Reads overlay switches from a query string or form ("1"/"on" = on). */
export function parseOverlayOptions(get: (k: string) => string | null): OverlayOptions {
  const on = (k: keyof OverlayOptions, dflt: boolean) => {
    const v = get(k);
    return v === null ? dflt : v === "1" || v === "on" || v === "true";
  };
  return { showText: on("showText", true), showDate: on("showDate", true), showVenue: on("showVenue", true), showCta: on("showCta", false), showOrganizer: on("showOrganizer", false) };
}

/** A generation image that belongs to this event (never an arbitrary URL from the browser). */
async function generationImage(eventId: string, generationId: string, index: number) {
  if (!/^[0-9a-f-]{36}$/i.test(generationId) || !Number.isInteger(index) || index < 0 || index > 3) throw new UserError("Artwork not found.");
  const [g] = await db
    .select()
    .from(bannerGenerations)
    .where(and(eq(bannerGenerations.id, generationId), eq(bannerGenerations.eventId, eventId), eq(bannerGenerations.status, "succeeded")));
  const url = (g?.imageUrls as string[] | undefined)?.[index];
  if (!g || !url) throw new UserError("Artwork not found.");
  const bytes = await loadImageBytes(url);
  if (!bytes) throw new UserError("The artwork file couldn't be loaded. Please generate it again.");
  return { generation: g, bytes };
}

async function overlayFor(event: Event, opts: OverlayOptions): Promise<BannerOverlay> {
  const [org] = await db.select({ name: organizerProfiles.displayName }).from(organizerProfiles).where(eq(organizerProfiles.id, event.organizerId));
  return {
    title: event.title,
    startsAt: event.startsAt,
    timezone: event.timezone,
    venue: [event.venueName, event.city].filter(Boolean).join(", "),
    organizerName: org?.name ?? null,
    ...opts,
  };
}

export async function renderBanner(event: Event, generationId: string, index: number, format: BannerFormat, opts: OverlayOptions) {
  const { bytes } = await generationImage(event.id, generationId, index);
  return composeBanner(bytes, format, await overlayFor(event, opts));
}

/**
 * Composes the 16:9 banner and makes it the event cover. An existing cover is
 * only replaced with explicit confirmation; the previous file is kept in
 * storage and its URL recorded in the audit log.
 */
export async function saveBannerAsCover(args: { actor: User; event: Event; generationId: string; index: number; opts: OverlayOptions; confirmReplace: boolean }) {
  const { event } = args;
  if (event.status === "cancelled") throw new UserError("Cancelled events can't be edited.");
  if (event.coverImageUrl && !args.confirmReplace) {
    throw new UserError("This event already has a cover image. Tick “Replace the current cover” to confirm.", "confirm_replace");
  }
  const bytes = await renderBanner(event, args.generationId, args.index, "landscape", args.opts);
  const url = await storage().put(bytes, { ext: "jpg", mime: "image/jpeg" }, "events");
  await db.transaction(async (tx) => {
    // Only replace the cover we showed the organizer (a concurrent edit wins otherwise).
    const rows = await tx
      .update(events)
      .set({ coverImageUrl: url, updatedAt: new Date() })
      .where(and(eq(events.id, event.id), event.coverImageUrl ? eq(events.coverImageUrl, event.coverImageUrl) : sql`${events.coverImageUrl} is null`))
      .returning({ id: events.id });
    if (rows.length === 0) throw new UserError("The cover changed while you were working. Reload the page and try again.");
    await audit(tx, {
      actorUserId: args.actor.id,
      action: "event.cover_set_from_ai",
      entityType: "event",
      entityId: event.id,
      metadata: { generationId: args.generationId, index: args.index, previousCoverUrl: event.coverImageUrl, newCoverUrl: url, overlay: args.opts },
    });
  });
  return url;
}

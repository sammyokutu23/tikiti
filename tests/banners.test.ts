/**
 * AI Banner Studio. The OpenAI call is replaced by a fake generator: these tests
 * prove our code paths (limits, storage, composition, errors) — not OpenAI output.
 */
import { APIConnectionTimeoutError, APIError } from "openai";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, bannerGenerations, events } from "@/db/schema";
import { resetRateLimits } from "@/lib/rate-limit";
import { imageApiConfig, imageApiStatus, setImageGeneratorOverride, type ImageGenerator } from "@/server/banners/openai";
import { buildBannerPrompt, generateBannerSchema } from "@/server/banners/prompt";
import { DEFAULT_BANNER_LIMITS, generateEventBanners, renderBanner, saveBannerAsCover, setBannerLimits } from "@/server/banners/service";
import { approveExternalListing, createExternalListing } from "@/server/resale/listings";
import { ensureOutsideEventBanner } from "@/server/resale/banner";
import { makeEvent, makeOrganizer, makeUser, resetDb } from "./helpers";

const FAKE_KEY = "sk-test-0123456789abcdefghijklmnop";
let calls: { prompt: string; size: string; n: number; endUser: string }[] = [];
let jpeg: string;

const okGenerator: ImageGenerator = async (_cfg, req) => {
  calls.push(req);
  return { b64: Array.from({ length: req.n }, () => jpeg) };
};
const failWith = (err: unknown): ImageGenerator => async () => {
  throw err;
};

async function setup() {
  const { user, organizer } = await makeOrganizer();
  const { event } = await makeEvent(organizer.id);
  return { user, organizer, event };
}
const input = (over: Record<string, unknown> = {}) =>
  generateBannerSchema.parse({ style: "afro_tropical", format: "landscape", category: "music", brief: "Sunset rooftop, warm amber lights", count: 1, ...over });

beforeEach(async () => {
  await resetDb();
  resetRateLimits();
  calls = [];
  process.env.OPENAI_API_KEY = FAKE_KEY;
  process.env.OPENAI_IMAGE_MODEL = "gpt-image-2.5-flare";
  jpeg ??= (await sharp({ create: { width: 1536, height: 1024, channels: 3, background: { r: 40, g: 90, b: 160 } } }).jpeg().toBuffer()).toString("base64");
  setImageGeneratorOverride(okGenerator);
});
afterEach(() => {
  setImageGeneratorOverride(null);
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_IMAGE_MODEL;
});

describe("configuration", () => {
  it("requires a key and a GPT Image model, and never reports the key", () => {
    expect(imageApiStatus()).toEqual({ configured: true, model: "gpt-image-2.5-flare", quality: "medium" });
    expect(JSON.stringify(imageApiStatus())).not.toContain(FAKE_KEY);
    expect(() => imageApiConfig({ OPENAI_IMAGE_MODEL: "gpt-image-2.5-flare" })).toThrow(/OPENAI_API_KEY/);
    expect(() => imageApiConfig({ OPENAI_API_KEY: FAKE_KEY })).toThrow(/OPENAI_IMAGE_MODEL/);
    expect(() => imageApiConfig({ OPENAI_API_KEY: FAKE_KEY, OPENAI_IMAGE_MODEL: "dall-e-3" })).toThrow(/GPT Image/);
  });

  it("refuses to generate (and records nothing) when not configured", async () => {
    delete process.env.OPENAI_API_KEY;
    const { user, event } = await setup();
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(/aren't available/);
    expect(await db.$count(bannerGenerations)).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("prompt", () => {
  it("asks for text-free artwork, never includes the event title, and strips contact details", () => {
    const p = buildBannerPrompt(input({ brief: "Call 0712 345 678 or visit https://evil.example and mail me@x.com — neon jungle vibes" }));
    expect(p).toMatch(/NO text/);
    expect(p).toContain("neon jungle vibes");
    expect(p).not.toMatch(/0712|evil\.example|me@x\.com/);
    expect(p).not.toContain("Test Event");
  });

  it("validates the brief length and enums", () => {
    expect(generateBannerSchema.safeParse({ style: "x", format: "landscape", category: "music" }).success).toBe(false);
    expect(generateBannerSchema.safeParse({ style: "minimal_elegant", format: "landscape", category: "music", brief: "a".repeat(601) }).success).toBe(false);
  });
});

describe("generation", () => {
  it("stores each concept and records usage", async () => {
    const { user, event, organizer } = await setup();
    const g = await generateEventBanners({ actor: user, event, input: input({ count: 2 }) });
    expect(g).toMatchObject({ status: "succeeded", imageCount: 2, model: "gpt-image-2.5-flare", size: "1536x1024" });
    expect(g.imageUrls).toHaveLength(2);
    for (const u of g.imageUrls as string[]) expect(u).toMatch(/^\/media\/banners\//);
    expect(calls[0].n).toBe(2);
    expect(calls[0].endUser).not.toContain(organizer.id);
    expect(calls[0].prompt).not.toContain(event.title);
    const [a] = await db.select().from(auditLogs).where(eq(auditLogs.action, "banner.generated"));
    expect(a.metadata).toMatchObject({ images: 2 });
  });

  it("caps images per request at the configured maximum", async () => {
    const { user, event } = await setup();
    const g = await generateEventBanners({ actor: user, event, input: input({ count: 4 }) });
    expect(g.imageCount).toBe(DEFAULT_BANNER_LIMITS.maxImagesPerRequest);
  });

  it("enforces the per-organizer daily limit; failed requests don't count", async () => {
    const admin = await makeUser("admin");
    await setBannerLimits({ ...DEFAULT_BANNER_LIMITS, imagesPerOrganizerPerDay: 2, requestsPerUserPerMinute: 30 }, admin);
    const { user, event } = await setup();
    setImageGeneratorOverride(failWith(new APIError(500, { message: "boom" }, "boom", new Headers())));
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(/had a problem/);
    setImageGeneratorOverride(okGenerator);
    await generateEventBanners({ actor: user, event, input: input({ count: 2 }) });
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(/today's AI banner limit/);
    expect(calls).toHaveLength(1);
    const rows = await db.select().from(bannerGenerations);
    expect(rows.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
  });

  it("allows only one generation in flight per organizer (double clicks)", async () => {
    const { user, event } = await setup();
    await db.insert(bannerGenerations).values({ organizerId: event.organizerId, eventId: event.id, model: "m", style: "s", format: "landscape", size: "1536x1024", quality: "medium", imageCount: 1 });
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(/already being generated/);
    expect(calls).toHaveLength(0);
  });

  it("can be switched off by an admin", async () => {
    const admin = await makeUser("admin");
    await setBannerLimits({ ...DEFAULT_BANNER_LIMITS, enabled: false }, admin);
    const { user, event } = await setup();
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(/switched off/);
  });

  it.each([
    [new APIError(400, { message: "blocked", code: "moderation_blocked", type: "image_generation_user_error" }, "blocked", new Headers()), /can't be used/, "moderation"],
    [new APIError(429, { message: "You exceeded your current quota", code: "insufficient_quota" }, "quota", new Headers()), /temporarily unavailable/, "quota"],
    [new APIError(429, { message: "Rate limit" }, "Rate limit", new Headers()), /busy/, "rate_limited"],
    [new APIError(401, { message: "bad key" }, "bad key", new Headers()), /temporarily unavailable/, "config"],
    [new APIConnectionTimeoutError(), /took too long/, "timeout"],
  ])("maps provider errors to safe messages (%#)", async (err, message, category) => {
    const { user, event } = await setup();
    setImageGeneratorOverride(failWith(err));
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(message);
    const [row] = await db.select().from(bannerGenerations);
    expect(row).toMatchObject({ status: "failed", errorCategory: category });
    expect(row.errorMessage).not.toMatch(/sk-|quota exceeded for org/i);
  });

  it("rejects provider output that isn't an image", async () => {
    const { user, event } = await setup();
    setImageGeneratorOverride(async () => ({ b64: [Buffer.from("not an image at all".repeat(100)).toString("base64")] }));
    await expect(generateEventBanners({ actor: user, event, input: input() })).rejects.toThrow(/invalid/);
  });
});

describe("composition & saving", () => {
  it("renders every format at its exact size from server-side event data", async () => {
    const { user, event } = await setup();
    const g = await generateEventBanners({ actor: user, event, input: input() });
    const opts = { showText: true, showDate: true, showVenue: true, showCta: true, showOrganizer: true };
    for (const [format, w, h] of [["landscape", 1600, 900], ["square", 1080, 1080], ["portrait", 1080, 1620]] as const) {
      const meta = await sharp(Buffer.from(await renderBanner(event, g.id, 0, format, opts))).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", w, h]);
    }
  });

  it("only uses artwork generated for this event", async () => {
    const a = await setup();
    const b = await setup();
    const g = await generateEventBanners({ actor: a.user, event: a.event, input: input() });
    await expect(renderBanner(b.event, g.id, 0, "landscape", { showText: true, showDate: true, showVenue: true, showCta: false, showOrganizer: false })).rejects.toThrow(/not found/);
  });

  it("never replaces an existing cover without explicit confirmation, and keeps the old URL in the audit log", async () => {
    const { user, event } = await setup();
    await db.update(events).set({ coverImageUrl: "/media/events/original.jpg" }).where(eq(events.id, event.id));
    const ev = (await db.select().from(events).where(eq(events.id, event.id)))[0];
    const g = await generateEventBanners({ actor: user, event: ev, input: input() });
    const opts = { showText: true, showDate: true, showVenue: true, showCta: false, showOrganizer: false };
    await expect(saveBannerAsCover({ actor: user, event: ev, generationId: g.id, index: 0, opts, confirmReplace: false })).rejects.toThrow(/Replace the current cover/);
    expect((await db.select().from(events).where(eq(events.id, ev.id)))[0].coverImageUrl).toBe("/media/events/original.jpg");

    const url = await saveBannerAsCover({ actor: user, event: ev, generationId: g.id, index: 0, opts, confirmReplace: true });
    expect(url).toMatch(/^\/media\/events\//);
    expect((await db.select().from(events).where(eq(events.id, ev.id)))[0].coverImageUrl).toBe(url);
    const [a] = await db.select().from(auditLogs).where(eq(auditLogs.action, "event.cover_set_from_ai"));
    expect(a.metadata).toMatchObject({ previousCoverUrl: "/media/events/original.jpg", newCoverUrl: url });
  });
});

describe("outside resale event banners", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);
  const local = (days: number, h: number) => new Date(Date.now() + days * 86_400_000 + h * 3600_000).toISOString().slice(0, 16);

  async function submit(seller: { id: string }) {
    return createExternalListing(
      { eventName: "Blankets & Wine", venue: "Ngong Racecourse", city: "Nairobi", startsAtLocal: local(10, 0), ticketTypeName: "GA", platform: "Mookh", orderRef: "", note: "", priceKes: 3000, payoutPhone: "254711000222" },
      { ticket: { filename: "t.png", contentType: "image/png", data: png }, proof: { filename: "r.png", contentType: "image/png", data: png } },
      seller.id,
    );
  }

  it("gives a newly created outside event an AI cover in its category's style, once", async () => {
    const admin = await makeUser("admin");
    const listing = await submit(await makeUser());
    const { eventId } = await approveExternalListing(
      listing.id,
      { mode: "create", title: "Blankets & Wine", venue: "Ngong Racecourse", city: "Nairobi", category: "festival", startsAtLocal: local(10, 0), endsAtLocal: local(10, 8) },
      admin.id,
    );
    expect(await ensureOutsideEventBanner(eventId, admin)).toBe(true);
    const [ev] = await db.select().from(events).where(eq(events.id, eventId));
    expect(ev.coverImageUrl).toMatch(/^\/media\/events\//);
    expect(calls).toHaveLength(1);
    expect(calls[0].size).toBe("1536x1024");
    expect(calls[0].prompt).toContain("open-air festival");
    expect(calls[0].prompt).not.toContain("Blankets");

    // Already has a cover: nothing generated or billed.
    expect(await ensureOutsideEventBanner(eventId, admin)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("never touches an organizer's own event", async () => {
    const admin = await makeUser("admin");
    const { event } = await setup();
    expect(await ensureOutsideEventBanner(event.id, admin)).toBe(false);
    expect(calls).toHaveLength(0);
    expect((await db.select().from(events).where(eq(events.id, event.id)))[0].coverImageUrl).toBe(event.coverImageUrl);
  });
});

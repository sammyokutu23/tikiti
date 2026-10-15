/** Serverless pieces: Supabase Storage driver and the cron tick endpoint (no network: fetch is stubbed). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { saveEventImage, supabaseStorageConfig } from "@/server/storage";
import { GET as cronTick } from "@/app/api/cron/tick/route";
import { resetDb } from "./helpers";

const png = () => {
  const b = new Uint8Array(4096);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new File([b], "cover.png", { type: "image/png" });
};

describe("Supabase storage driver", () => {
  beforeEach(() => {
    process.env.STORAGE_DRIVER = "supabase";
    process.env.SUPABASE_URL = "https://abcdefghijklmnop.supabase.co";
    process.env.SUPABASE_SERVICE_KEY = "sb_secret_test";
  });
  afterEach(() => {
    for (const k of ["STORAGE_DRIVER", "SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SUPABASE_STORAGE_BUCKET"]) delete process.env[k];
    vi.unstubAllGlobals();
  });

  it("uploads validated images to the bucket and returns the public URL", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    });
    const out = await saveEventImage(png());
    expect(out).toMatch(/^https:\/\/abcdefghijklmnop\.supabase\.co\/storage\/v1\/object\/public\/event-images\/events\/\d+-[\w-]+\.png$/);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/storage\/v1\/object\/event-images\/events\//);
    const h = calls[0].init.headers as Record<string, string>;
    expect(h["Content-Type"]).toBe("image/png");
    expect(h.Authorization).toBe("Bearer sb_secret_test");
  });

  it("never uploads a file that isn't a real image", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(saveEventImage(new File([new Uint8Array(4096)], "x.png", { type: "image/png" }))).rejects.toThrow(/Unsupported image/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a friendly error when Supabase rejects the upload", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":"Bucket not found"}', { status: 404 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(saveEventImage(png())).rejects.toThrow(/couldn't be uploaded/);
  });

  it("validates configuration", () => {
    expect(() => supabaseStorageConfig({ SUPABASE_URL: "http://evil.example", SUPABASE_SERVICE_KEY: "k" })).toThrow(/SUPABASE_URL/);
    expect(() => supabaseStorageConfig({ SUPABASE_URL: "https://abc.supabase.co" })).toThrow(/SUPABASE_SERVICE_KEY/);
    expect(supabaseStorageConfig({ SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_KEY: "k" })).toEqual({ url: "https://abc.supabase.co", key: "k", bucket: "event-images" });
  });
});

describe("cron tick endpoint", () => {
  beforeEach(resetDb);
  afterEach(() => delete process.env.CRON_SECRET);
  const call = (auth?: string) => cronTick(new Request("http://localhost/api/cron/tick", { headers: auth ? { authorization: auth } : {} }));

  it("is disabled without a CRON_SECRET", async () => {
    expect((await call("Bearer anything")).status).toBe(503);
  });

  it("rejects missing or wrong secrets", async () => {
    process.env.CRON_SECRET = "s".repeat(32);
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
  });

  it("runs due background jobs when authorized", async () => {
    process.env.CRON_SECRET = "s".repeat(32);
    await db.insert(jobs).values({ type: "test.noop", payload: {}, dedupeKey: "cron-test" });
    const res = await call(`Bearer ${"s".repeat(32)}`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    const [j] = await db.select().from(jobs);
    expect(j.attempts).toBe(1); // the tick picked the job up (it has no handler, so it records the error)
    expect(j.lastError).toMatch(/No handler/);
  });
});

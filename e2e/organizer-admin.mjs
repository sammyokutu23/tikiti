/**
 * Browser E2E for organizer onboarding, event publishing, check-in and admin moderation.
 *   node e2e/organizer-admin.mjs [baseUrl]   (requires seeded DB: npm run db:seed)
 */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import pg from "pg";
import "dotenv/config";
import { prepareClerk, signInAs } from "./clerk-auth.mjs";

const base = process.argv[2] ?? "http://localhost:3000";
const shots = process.env.SHOTS_DIR;
const step = (s) => console.log("✓", s);
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const db = new pg.Client(process.env.DATABASE_URL);
await db.connect();
await prepareClerk(db);

async function login(email, viewport = { width: 1280, height: 900 }) {
  const ctx = await b.newContext({ viewport });
  const p = await ctx.newPage();
  await signInAs(p, base, email);
  return p;
}

// cover image: 1200x600 PNG
const png = new PNG({ width: 1200, height: 600 });
for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 40; png.data[i + 1] = (i / 4) % 255; png.data[i + 2] = 140; png.data[i + 3] = 255; }
const pngBuf = PNG.sync.write(png);

// 0. Auth controls: signed out → Sign in / Sign up; signed in → Clerk user button.
const anon = await b.newPage();
await anon.goto(`${base}/`);
await anon.getByRole("button", { name: "Sign in" }).waitFor();
await anon.getByRole("button", { name: "Sign up" }).waitFor();
await anon.goto(`${base}/organizer`);
assert.match(anon.url(), /\/sign-in\?redirect_url=/);
step("signed-out header shows Sign in / Sign up; protected page redirects to Clerk sign-in");

// 1. Pending organizer creates an event but cannot publish
const org = await login("pending@tikiti.test");
await org.goto(`${base}/organizer`);
await org.locator(".cl-userButtonTrigger").waitFor({ timeout: 15000 });
assert.equal(await org.getByRole("button", { name: "Sign in" }).count(), 0);
step("signed in via Clerk; user button visible; local demo account linked by verified email");
await org.goto(`${base}/organizer`);
await org.getByText("Verification pending").waitFor();
await org.goto(`${base}/organizer/events/new`);
const title = `Coastal Jazz Night ${Date.now() % 100000}`;
await org.locator('input[name="coverImage"]').setInputFiles({ name: "cover.png", mimeType: "image/png", buffer: pngBuf });
await org.getByLabel("Event title").fill(title);
await org.getByLabel("Short summary").fill("Smooth jazz by the ocean.");
await org.getByLabel("Description").fill("An evening of live jazz on the beach with local and international artists.");
await org.getByLabel("Category").selectOption("music");
await org.getByLabel("Starts").fill("2026-12-05T18:00");
await org.getByLabel("Ends").fill("2026-12-05T23:00");
await org.getByLabel("Venue name").fill("Nyali Beach Hotel Gardens");
await org.getByLabel("City / town").fill("Mombasa");
// Drop the pin manually (no geocoder call) and confirm it.
await org.locator(".tikosoko-map .leaflet-tile-loaded").first().waitFor({ timeout: 20000 });
await org.getByRole("button", { name: "Set pin at map centre" }).click();
await org.getByRole("button", { name: "Confirm pin" }).click();
await org.getByRole("button", { name: "Create draft" }).click();
await org.waitForURL(/\/organizer\/events\/[0-9a-f-]{36}\?ok=/);
const eventId = org.url().match(/events\/([0-9a-f-]{36})/)[1];
step("pending organizer created a draft with an uploaded cover");
const cover = (await db.query("select cover_image_url from events where id=$1", [eventId])).rows[0].cover_image_url;
assert.match(cover, /^\/media\/events\/.+\.png$/);
assert.equal((await org.request.get(`${base}${cover}`)).headers()["content-type"], "image/png");

// invalid upload rejected
await org.goto(`${base}/organizer/events/${eventId}`);
const form = org.locator("form", { has: org.getByRole("button", { name: "Save changes" }) });
await form.locator('input[name="coverImage"]').setInputFiles({ name: "evil.png", mimeType: "image/png", buffer: Buffer.from("<svg onload=alert(1)>" + " ".repeat(2000)) });
await form.getByRole("button", { name: "Save changes" }).click();
await org.getByText("Unsupported image").waitFor();
step("disguised non-image upload rejected");

await org.goto(`${base}/organizer/events/${eventId}`);
const add = org.locator("form", { has: org.getByRole("button", { name: "Add ticket type" }) });
await add.getByLabel("Name").fill("Regular");
await add.getByLabel("Price (KES)").fill("1500");
await add.getByLabel("Quantity available").fill("2");
await add.getByRole("button", { name: "Add ticket type" }).click();
await org.getByText("Ticket type saved.").waitFor();
await org.reload();
assert.equal(await org.getByRole("button", { name: "Publish event" }).isDisabled(), true);
step("ticket type added; publish disabled while unverified");
if (shots) await org.screenshot({ path: `${shots}/org-manage.png`, fullPage: false });

// 2. Admin verifies the organizer
const admin = await login("admin@tikiti.test");
await admin.goto(`${base}/admin/organizers?status=pending`);
const card = admin.locator("div.rounded-3xl", { hasText: "Pwani Vibes Entertainment" }).first();
await card.getByRole("button", { name: "Verify" }).click();
await admin.getByText("Organizer marked verified.").waitFor();
step("admin verified the organizer");

// 3. Organizer (new session picks up role) publishes
const org2 = await login("pending@tikiti.test");
await org2.goto(`${base}/organizer/events/${eventId}`);
await org2.getByRole("button", { name: "Publish event" }).click();
await org2.getByText("Event published!").waitFor();
const slug = (await db.query("select slug from events where id=$1", [eventId])).rows[0].slug;
const pub = await b.newPage();
await pub.goto(`${base}/events/${slug}`);
await pub.getByRole("heading", { name: title }).waitFor();
step("event published and publicly visible");

// buy both tickets as a guest, then the event is sold out
await pub.getByRole("button", { name: "Add one Regular ticket" }).click();
await pub.getByRole("button", { name: "Add one Regular ticket" }).click();
assert.equal(await pub.getByRole("button", { name: "Add one Regular ticket" }).isDisabled(), true);
await pub.getByRole("button", { name: /Buy tickets/ }).click();
await pub.getByLabel("Full name").fill("Hassan Ali");
await pub.getByLabel("Email address").fill("hassan@example.com");
await pub.getByLabel("Phone number").fill("0722 333 444");
await pub.getByRole("checkbox").check();
await pub.getByRole("button", { name: /Continue to payment/ }).click();
await pub.getByRole("button", { name: /Pay KES 3,000/ }).click();
await pub.getByRole("button", { name: "Approve payment", exact: true }).click();
await pub.getByRole("heading", { name: /You're in/ }).waitFor({ timeout: 15000 });
step("guest bought the last 2 tickets");
await pub.goto(`${base}/events/${slug}`);
await pub.getByText("Sold out").first().waitFor();
step("event shows sold out");

// 4. Check-in via manual entry on the scanner page
const codes = (await db.query("select code from tickets where event_id=$1 order by code", [eventId])).rows.map((r) => r.code);
assert.equal(codes.length, 2);
await org2.goto(`${base}/organizer/events/${eventId}/scan`);
await org2.getByLabel("Ticket code").fill(codes[0]);
await org2.getByRole("button", { name: "Check", exact: true }).click();
await org2.getByText("Valid ticket — admit", { exact: true }).waitFor();
await org2.getByRole("button", { name: "Check", exact: true }).click();
await org2.getByText("Already checked in", { exact: true }).waitFor();
step("first scan admitted, repeat scan rejected");
const other = (await db.query("select t.code from tickets t join events e on e.id=t.event_id where e.slug='afrosonic-live-nairobi' and t.status='valid' limit 1")).rows[0].code;
await org2.getByLabel("Ticket code").fill(other);
await org2.getByRole("button", { name: "Check", exact: true }).click();
await org2.getByText("Ticket is for a different event", { exact: true }).waitFor();
step("ticket from another organizer's event rejected as wrong event");
if (shots) await org2.screenshot({ path: `${shots}/org-scan.png` });

// 5. Cross-organizer isolation
const nlc = await login("organizer@tikiti.test");
const r1 = await nlc.goto(`${base}/organizer/events/${eventId}`);
assert.equal(r1.status(), 404);
const r2 = await nlc.request.get(`${base}/api/organizer/events/${eventId}/attendees`);
assert.equal(r2.status(), 404);
const r3 = await nlc.request.post(`${base}/api/organizer/events/${eventId}/scan`, { data: { raw: codes[1] }, headers: { origin: base } });
assert.equal(r3.status(), 404);
const r4 = await nlc.goto(`${base}/admin`);
assert.equal(r4.status(), 404);
step("other organizer gets 404 on event page, CSV export, scan API and admin area");

// 6. Admin hides the event → disappears publicly
await admin.goto(`${base}/admin/events?q=${encodeURIComponent(title)}`);
await admin.getByRole("button", { name: "Hide", exact: true }).click();
await admin.getByText("Event hidden from the public.").waitFor();
await pub.goto(`${base}/events/${slug}`);
// Streaming route (loading.tsx) → Next serves a soft 404: not-found UI + noindex.
await pub.getByRole("paragraph").filter({ hasText: "Event not found" }).first().waitFor();
assert.equal(await pub.getByRole("heading", { name: title }).count(), 0);
step("admin hid the event; public page now 404");
if (shots) {
  await admin.goto(`${base}/admin`);
  await admin.screenshot({ path: `${shots}/admin-home.png` });
}

await db.end();
await b.close();
console.log("E2E organizer/admin flow passed");

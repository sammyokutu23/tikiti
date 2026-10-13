/**
 * Browser E2E for venue location: organizer picker (real Nominatim search + OSM tiles),
 * pin drag/confirm, persistence, public map + directions, fallback, authorization.
 *   node e2e/location.mjs [baseUrl]   (dev server on a seeded DB; needs internet for OSM)
 */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
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

const org = await login("organizer@tikiti.test");
await org.goto(`${base}/organizer/events/new`);
const title = `Summit Afterparty ${Date.now() % 100000}`;
await org.getByLabel("Event title").fill(title);
await org.getByLabel("Description").fill("Networking drinks after the summit with live DJs on the KICC grounds.");
await org.getByLabel("Category").selectOption("nightlife");
await org.getByLabel("Starts").fill("2026-12-10T19:00");
await org.getByLabel("Ends").fill("2026-12-10T23:30");

// Saving without a pin shows a clear validation message.
await org.getByRole("button", { name: "Create draft" }).click();
await org.getByText("Set the venue location on the map").waitFor();
step("missing location → validation message");

// Search a Kenyan venue (real Nominatim through /api/geocode).
await org.getByLabel("Search for the venue").fill("KICC Nairobi");
const results = org.getByRole("listbox", { name: "Search results" });
for (let attempt = 1; ; attempt++) {
  await org.getByRole("button", { name: "Search", exact: true }).click();
  const outcome = await Promise.race([
    results.waitFor({ timeout: 20000 }).then(() => "ok"),
    org.getByText(/temporarily unavailable|search failed/i).waitFor({ timeout: 20000 }).then(() => "provider-error"),
    org.getByText(/^No matches/).waitFor({ timeout: 20000 }).then(() => "no-matches"),
  ]);
  if (outcome === "ok") break;
  if (outcome === "no-matches") throw new Error("Geocoder returned no matches for the test query");
  if (attempt === 3) throw new Error("Nominatim unavailable after 3 attempts");
  console.log("  (geocoder slow/unavailable — UI showed the fallback message; retrying)");
  await org.waitForTimeout(2000);
}
const firstResult = results.getByRole("option").first();
await firstResult.getByRole("button").click();
await org.locator(".tikiti-pin").waitFor();
const filledName = await org.getByLabel("Venue name").inputValue();
assert.ok(filledName.length > 1);
assert.equal(await org.getByLabel("City / town").inputValue(), "Nairobi");
step(`Nominatim result selected; empty venue fields filled (“${filledName}”)`);
if (shots) await org.locator("fieldset").screenshot({ path: `${shots}/loc-picker.png` });

const pinText = async () => (await org.getByText(/^Pin: /).textContent()).match(/(-?\d+\.\d+), (-?\d+\.\d+)/).slice(1).map(Number);
const geocoded = await pinText();

// Save before confirming → asks to confirm.
await org.getByRole("button", { name: "Create draft" }).click();
await org.getByText("Confirm the pin position").waitFor();
assert.equal(await org.getByLabel("Category").inputValue(), "nightlife"); // form values survive a failed submit
step("unconfirmed pin → asked to confirm; other fields kept");

// Drag the marker to refine the entrance.
await org.locator(".tikiti-pin").evaluate((el) => el.scrollIntoView({ block: "center" }));
await org.waitForTimeout(200);
const pinBox = await org.locator(".tikiti-pin").boundingBox();
await org.mouse.move(pinBox.x + pinBox.width / 2, pinBox.y + pinBox.height - 4);
await org.mouse.down();
await org.mouse.move(pinBox.x + pinBox.width / 2 + 60, pinBox.y + pinBox.height + 30, { steps: 10 });
await org.mouse.up();
await org.waitForTimeout(300);
const dragged = await pinText();
assert.notDeepEqual(dragged, geocoded);
await org.getByRole("button", { name: "Confirm pin" }).click();
await org.getByRole("button", { name: "Pin confirmed" }).waitFor();
await org.getByLabel("Entrance & arrival instructions (optional)").fill("Enter via Gate 3 on Harambee Avenue.");
await org.getByRole("button", { name: "Create draft" }).click();
await org.waitForURL(/\/organizer\/events\/[0-9a-f-]{36}\?ok=/);
const eventId = org.url().match(/events\/([0-9a-f-]{36})/)[1];
let row = (await db.query("select latitude, longitude, location_provider, location_place_id, location_confirmed_at, arrival_instructions, slug, description from events where id=$1", [eventId])).rows[0];
assert.ok(Math.abs(row.latitude - dragged[0]) < 1e-5 && Math.abs(row.longitude - dragged[1]) < 1e-5);
assert.equal(row.location_provider, "nominatim");
assert.match(row.location_place_id, /^osm:/);
assert.ok(row.location_confirmed_at);
step(`dragged pin saved: ${row.latitude}, ${row.longitude} (geocoded was ${geocoded.join(", ")})`);

// Reload: coordinates preserved and shown as confirmed.
await org.reload();
await org.getByText(new RegExp(`Pin: ${row.latitude.toFixed(5)}, ${row.longitude.toFixed(5)} · confirmed`)).waitFor();
step("reload shows the same confirmed pin");

// Edit an unrelated field: location and other data preserved.
await org.getByLabel("Short summary").fill("Drinks & DJs after day one.");
await org.getByRole("button", { name: "Save changes" }).click();
await org.getByText("Event saved.").waitFor();
const row2 = (await db.query("select latitude, longitude, summary, description, arrival_instructions from events where id=$1", [eventId])).rows[0];
assert.deepEqual([row2.latitude, row2.longitude, row2.description, row2.arrival_instructions], [row.latitude, row.longitude, row.description, row.arrival_instructions]);
assert.equal(row2.summary, "Drinks & DJs after day one.");
step("editing the summary preserved coordinates and other fields");

// Publish (needs a ticket type).
const add = org.locator("form", { has: org.getByRole("button", { name: "Add ticket type" }) });
await add.getByLabel("Name").fill("Entry");
await add.getByLabel("Price (KES)").fill("500");
await add.getByLabel("Quantity available").fill("100");
await add.getByRole("button", { name: "Add ticket type" }).click();
await org.getByText("Ticket type saved.").waitFor();
await org.reload();
await org.getByRole("button", { name: "Publish event" }).click();
await org.getByText("Event published!").waitFor();

// Public page — desktop and mobile.
for (const [label, vp] of [["desktop", { width: 1440, height: 1000 }], ["mobile", { width: 390, height: 844 }]]) {
  const ctx = await b.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
  const p = await ctx.newPage();
  await p.goto(`${base}/events/${row.slug}`);
  const section = p.locator("#location");
  await section.scrollIntoViewIfNeeded();
  await section.locator(".leaflet-marker-icon").waitFor({ timeout: 15000 });
  await section.locator(".leaflet-tile-loaded").first().waitFor({ timeout: 15000 });
  // Marker sits where the map is centred, i.e. on the saved coordinates.
  const mapBox = await section.locator(".leaflet-container").boundingBox();
  const mk = await section.locator(".leaflet-marker-icon").boundingBox();
  assert.ok(Math.abs(mk.x + mk.width / 2 - (mapBox.x + mapBox.width / 2)) < 2 && Math.abs(mk.y + mk.height - (mapBox.y + mapBox.height / 2)) < 2);
  const href = await section.getByRole("link", { name: "Get directions" }).getAttribute("href");
  assert.equal(href, `https://www.google.com/maps/dir/?api=1&destination=${row.latitude},${row.longitude}`);
  assert.ok(await section.getByText("OpenStreetMap").isVisible());
  await section.getByText("Enter via Gate 3 on Harambee Avenue.").waitFor();
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  assert.equal(sw, vp.width);
  await p.waitForLoadState("networkidle");
  if (shots) await section.screenshot({ path: `${shots}/loc-public-${label}.png` });
  // zoom works
  await section.getByRole("button", { name: "Zoom in" }).click();
  await p.waitForFunction(() => document.querySelector("#location .leaflet-container")?.__zoomOK !== false);
  step(`${label}: marker on saved pin, tiles + attribution, Get directions → ${href}`);
  await ctx.close();
}

// Event without coordinates → fallback, no marker, no directions button.
const pub = await b.newPage();
await pub.goto(`${base}/events/rift-valley-cycling-classic`);
await pub.locator("#location").getByText("hasn't pinned the exact location").waitFor();
assert.equal(await pub.locator("#location .leaflet-marker-icon").count(), 0);
assert.equal(await pub.getByRole("link", { name: "Get directions" }).count(), 0);
if (shots) await pub.locator("#location").screenshot({ path: `${shots}/loc-fallback.png` });
step("no-pin event shows address fallback, no false marker");

// Another organizer cannot open (or therefore edit) this event's location.
const other = await login("organizer2@tikiti.test");
const res = await other.goto(`${base}/organizer/events/${eventId}`);
assert.equal(res.status(), 404);
const geo = await (await b.newContext()).request.get(`${base}/api/geocode?q=KICC`);
assert.equal(geo.status(), 401);
step("other organizer gets 404; anonymous geocode API → 401");

await db.end();
await b.close();
console.log("E2E location flow passed");

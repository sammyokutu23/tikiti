/**
 * Browser smoke test of the guest purchase flow against a running dev server.
 *   node e2e/purchase.mjs [baseUrl]
 * Uses the locally installed Google Chrome (CHROME_PATH to override).
 */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://localhost:3000";
const shots = process.env.SHOTS_DIR;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
const p = await ctx.newPage();
const shot = async (n) => shots && p.screenshot({ path: `${shots}/${n}.png`, fullPage: true });
const step = (s) => console.log("✓", s);

await p.goto(`${base}/events/jazz-on-the-lawn`);
await p.getByRole("button", { name: "Add one Regular ticket" }).click();
await p.getByRole("button", { name: "Add one Regular ticket" }).click();
await p.getByRole("button", { name: /Buy tickets/ }).click();
await p.waitForURL(/\/checkout\?t=/);
step("selected 2 tickets and reached checkout");

// validation errors
await p.getByRole("button", { name: /Continue to payment/ }).click();
await p.getByText("Enter your full name").waitFor();
step("checkout validation shows field errors");
await p.getByLabel("Full name").fill("Amina Wairimu");
await p.getByLabel("Email address").fill("amina.e2e@example.com");
await p.getByLabel("Phone number").fill("0712 000 111");
await p.getByRole("checkbox").check();
await shot("e2e-checkout");
await p.getByRole("button", { name: /Continue to payment · KES 4,000/ }).click();
await p.waitForURL(/\/checkout\/TK-/);
const ref = p.url().match(/TK-[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];
step(`booking ${ref} reserved; on payment page`);
await shot("e2e-payment");

await p.getByRole("button", { name: /Pay (with M-Pesa · )?KES 4,000/ }).click();
await p.waitForURL(/\/pay\/mock\//);
await shot("e2e-mockpay");
await p.getByRole("button", { name: "Approve payment", exact: true }).click();
await p.waitForURL(/\/status/);
await p.getByRole("heading", { name: /You're in/ }).waitFor({ timeout: 15000 });
step("verified callback confirmed the booking");
await shot("e2e-success");

const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("link", { name: /Download tickets/ }).click()]);
const path = await dl.path();
const fs = await import("node:fs");
assert.equal(fs.readFileSync(path).subarray(0, 5).toString(), "%PDF-");
assert.match(dl.suggestedFilename(), new RegExp(`tikiti-jazz-on-the-lawn-${ref}\\.pdf`));
step(`downloaded ${dl.suggestedFilename()}`);

await p.getByRole("link", { name: /View tickets/ }).click();
await p.getByText("Your tickets (2)").waitFor();
assert.equal(await p.getByRole("img", { name: /QR code for ticket/ }).count(), 2);
step("booking page shows 2 tickets with QR codes");
await shot("e2e-booking");

// A different browser without the access cookie/link cannot see the booking.
const other = await b.newContext();
const op = await other.newPage();
await op.goto(`${base}/bookings/${ref}`);
await op.getByText("This booking is private").waitFor();
const res = await op.request.get(`${base}/api/bookings/${ref}/pdf`);
assert.equal(res.status(), 404);
step("another browser is denied the booking page and PDF");

// Declined payment keeps the reservation and allows a retry.
const p2 = await ctx.newPage();
await p2.goto(`${base}/events/rooftop-amapiano-sundays`);
await p2.getByRole("button", { name: "Add one Regular ticket" }).click();
await p2.getByRole("button", { name: /Buy tickets/ }).click();
await p2.getByLabel("Full name").fill("Amina Wairimu");
await p2.getByLabel("Email address").fill("amina.e2e@example.com");
await p2.getByLabel("Phone number").fill("0712 000 111");
await p2.getByRole("checkbox").check();
await p2.getByRole("button", { name: /Continue to payment/ }).click();
await p2.getByRole("button", { name: /Pay (with M-Pesa · )?KES 1,000/ }).click();
await p2.getByRole("button", { name: /Decline/ }).click();
await p2.getByRole("heading", { name: "Payment failed" }).waitFor({ timeout: 15000 });
step("declined payment shows failure state");
await p2.getByRole("link", { name: "Try again" }).click();
await p2.getByText("Your last payment didn't go through").waitFor();
await p2.getByRole("button", { name: /Pay (with M-Pesa · )?KES 1,000/ }).click();
await p2.getByRole("button", { name: "Approve payment", exact: true }).click();
await p2.getByRole("heading", { name: /You're in/ }).waitFor({ timeout: 15000 });
step("retry after decline confirmed the booking");

await b.close();
console.log("E2E purchase flow passed");

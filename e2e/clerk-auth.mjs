/**
 * Clerk sign-in for browser E2E (development instance only).
 * - Ensures one Clerk test user per demo role (+clerk_test emails are Clerk test addresses).
 * - Points the seeded local demo users at those emails, so the app links them on first
 *   sign-in exactly like a real user (verified-email linking).
 * - Signs in with Clerk sign-in tokens via @clerk/testing (no password, no CAPTCHA).
 */
import "dotenv/config";
import { createClerkClient } from "@clerk/backend";
import { clerk, clerkSetup, setupClerkTestingToken } from "@clerk/testing/playwright";

export const DEMO = {
  "admin@tikiti.test": "tikiti-e2e-admin+clerk_test@example.com",
  "organizer@tikiti.test": "tikiti-e2e-organizer+clerk_test@example.com",
  "organizer2@tikiti.test": "tikiti-e2e-organizer2+clerk_test@example.com",
  "pending@tikiti.test": "tikiti-e2e-pending+clerk_test@example.com",
  "customer@tikiti.test": "tikiti-e2e-customer+clerk_test@example.com",
};

let ready = false;
export async function prepareClerk(db) {
  if (ready) return;
  if (!process.env.CLERK_SECRET_KEY?.startsWith("sk_test_")) throw new Error("E2E requires a Clerk *development* secret key");
  process.env.CLERK_PUBLISHABLE_KEY ??= process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  await clerkSetup();
  const cc = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  for (const [demo, email] of Object.entries(DEMO)) {
    const existing = await cc.users.getUserList({ emailAddress: [email] });
    if (existing.data.length === 0) {
      await cc.users.createUser({ emailAddress: [email], firstName: demo.split("@")[0], skipPasswordRequirement: true });
    }
    await db.query("update users set email = $2 where lower(email) = $1", [demo, email]);
  }
  ready = true;
}

/** Signs the page's browser context in as the demo user, via a Clerk sign-in token. */
export async function signInAs(page, base, demoEmail) {
  await setupClerkTestingToken({ page });
  await page.goto(`${base}/`);
  await clerk.signIn({ page, emailAddress: DEMO[demoEmail] });
}

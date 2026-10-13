import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { after, type NextRequest } from "next/server";
import { handleClerkEmailEvent } from "@/server/email/clerk";
import { processDueJobs } from "@/server/jobs/queue";

/**
 * Optional: deliver Clerk's account emails (verification codes, password reset,
 * sign-in alerts) through Resend instead of Clerk's own mail servers.
 *
 * Only active when, in the Clerk dashboard, (1) a webhook endpoint pointing here
 * subscribes to `email.created` with its secret in CLERK_WEBHOOK_SIGNING_SECRET,
 * and (2) "Delivered by Clerk" is switched off for the templates you want us to
 * send. Emails Clerk delivers itself are ignored, so nothing is ever sent twice.
 * Clerk renders the content; it is kept only in the job payload and dropped once
 * the job finishes.
 */
export async function POST(req: NextRequest) {
  if (!process.env.CLERK_WEBHOOK_SIGNING_SECRET) return Response.json({ error: "Clerk webhooks are not configured" }, { status: 503 });
  let evt: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    evt = await verifyWebhook(req);
  } catch {
    return Response.json({ error: "Invalid signature" }, { status: 400 });
  }
  if (evt.type !== "email.created") return Response.json({ received: true });
  const outcome = await handleClerkEmailEvent(evt.data);
  // Sign-in codes are time-sensitive: send now rather than on the next worker tick.
  if (outcome === "queued") after(() => processDueJobs(5).catch((err) => console.error("[clerk-email] send failed:", (err as Error).message)));
  return Response.json({ received: true, outcome });
}

import { rateLimit } from "@/lib/rate-limit";
import { receiveResendWebhook } from "@/server/email/events";

/**
 * Resend delivery events (email.sent / delivered / delivery_delayed / bounced /
 * complained / failed / suppressed). Register this URL in Resend → Webhooks and
 * put the endpoint's signing secret in RESEND_WEBHOOK_SECRET. Requests are
 * rejected unless the Svix signature and timestamp verify; replays are no-ops.
 */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  if (!rateLimit(`resend-webhook:${ip}`, 600, 60_000).ok) return Response.json({ error: "Rate limited" }, { status: 429 });
  const body = await req.text();
  if (body.length > 256_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  try {
    const res = await receiveResendWebhook(body, req.headers);
    return Response.json(res.body, { status: res.status });
  } catch (err) {
    console.error("[resend] webhook processing error:", (err as Error).name);
    // 5xx → Resend retries the delivery later.
    return Response.json({ error: "Temporary error" }, { status: 500 });
  }
}

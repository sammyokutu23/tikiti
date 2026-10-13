import { handlePaymentWebhook } from "@/server/payments/service";
import { rateLimit } from "@/lib/rate-limit";

/** Provider callbacks. Signature verification happens inside the provider adapter. */
export async function POST(req: Request, ctx: RouteContext<"/api/webhooks/payments/[provider]">) {
  const { provider } = await ctx.params;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  if (!rateLimit(`webhook:${ip}`, 300, 60_000).ok) return Response.json({ error: "rate_limited" }, { status: 429 });
  const body = await req.text();
  if (body.length > 64_000) return Response.json({ error: "payload_too_large" }, { status: 413 });
  try {
    const res = await handlePaymentWebhook(provider, body, req.headers);
    return Response.json({ outcome: res.outcome }, { status: res.status });
  } catch (err) {
    if (err instanceof Error && /not configured/.test(err.message)) return Response.json({ error: "unknown_provider" }, { status: 404 });
    console.error("[webhook] processing error", err);
    // 500 tells the provider to retry later; processing is idempotent.
    return Response.json({ error: "processing_error" }, { status: 500 });
  }
}

import { after } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { processDueJobs } from "@/server/jobs/queue";
import { receiveMpesaCallback } from "@/server/payments/mpesa";

/**
 * Safaricom M-Pesa Express (STK Push) result callback.
 * Registered as DARAJA_CALLBACK_URL + "/" + DARAJA_CALLBACK_TOKEN. Must be
 * publicly reachable over HTTPS. The callback is stored and acknowledged
 * immediately; verification and ticket issuance run in the job queue (kicked
 * off right after the response, with the worker as a fallback).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/payments/stk/callback/[token]">) {
  const { token } = await ctx.params;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
  if (!rateLimit(`mpesa-callback:${ip ?? "local"}`, 300, 60_000).ok) {
    return Response.json({ ResultCode: 1, ResultDesc: "Rate limited" }, { status: 429 });
  }
  const body = await req.text();
  if (body.length > 16_000) return Response.json({ ResultCode: 1, ResultDesc: "Payload too large" }, { status: 413 });
  try {
    const res = await receiveMpesaCallback(body, { token, ip });
    if (res.eventId) {
      after(async () => {
        try {
          // First pass verifies/applies the callback; second sends the jobs it queued (tickets email).
          await processDueJobs(5);
          await processDueJobs(5);
        } catch (err) {
          console.error("[mpesa] post-callback processing failed:", (err as Error).message);
        }
      });
    }
    return Response.json(res.body, { status: res.status });
  } catch (err) {
    console.error("[mpesa] callback storage error:", (err as Error).name);
    return Response.json({ ResultCode: 1, ResultDesc: "Temporary error" }, { status: 500 });
  }
}

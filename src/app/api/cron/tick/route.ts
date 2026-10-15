import { safeEqual } from "@/lib/crypto";
import { workerTick } from "@/server/jobs/worker";

/**
 * One background-maintenance tick for serverless hosts, where no long-lived
 * worker runs: expire lapsed holds, reconcile M-Pesa payments, schedule
 * reminders and run due outbox jobs (emails, retries). Called every minute by
 * Supabase Cron (see docs/PRODUCTION.md), or by Vercel Cron, both with
 * `Authorization: Bearer <CRON_SECRET>`. Safe to call concurrently: jobs are
 * claimed with FOR UPDATE SKIP LOCKED.
 */
export const maxDuration = 60;

async function handle(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  const auth = req.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${secret}`)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const started = Date.now();
  await workerTick();
  return Response.json({ ok: true, ms: Date.now() - started }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = handle;
export const POST = handle;

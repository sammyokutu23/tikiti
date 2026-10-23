/**
 * Transactional outbox. Jobs are inserted in the same transaction as the state
 * change that requires them (e.g. booking confirmed → send email), so they are
 * never lost and never sent for a rolled-back change. A worker claims due jobs
 * with FOR UPDATE SKIP LOCKED and retries failures with exponential backoff.
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { jobs } from "@/db/schema";

export type JobType =
  | "email.send"
  | "email.event_update_fanout"
  | "refund.process"
  | "payment.mock_webhook"
  | "payment.mpesa_callback"
  | "resale.verify";

/**
 * Throw (or attach these fields to an error) from a handler to steer retries:
 * `retryable: false` fails the job immediately; `retryAfterMs` overrides backoff.
 */
export class JobError extends Error {
  constructor(message: string, public retryable: boolean, public retryAfterMs: number | null = null) {
    super(message);
    this.name = "JobError";
  }
}

export async function enqueueJob(
  tx: Tx,
  type: JobType,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {},
) {
  const [row] = await tx
    .insert(jobs)
    .values({
      type,
      payload,
      runAt: opts.runAt ?? new Date(),
      dedupeKey: opts.dedupeKey ?? null,
      maxAttempts: opts.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  return row?.id ?? null;
}

type Handler = (payload: Record<string, unknown>, job: { id: string; attempts: number; maxAttempts: number }) => Promise<void>;
// Kept on globalThis so a dev hot reload of this module can't leave the worker with an empty registry.
const handlers: Map<string, Handler> = ((globalThis as unknown as { __tikosokoJobHandlers?: Map<string, Handler> }).__tikosokoJobHandlers ??= new Map());

export function registerJobHandler(type: JobType, handler: Handler) {
  handlers.set(type, handler);
}

/** Exponential backoff: 15s, 1m, 4m, 16m, … capped at 1h, with ±20% jitter so retries don't stampede. */
export function backoffMs(attempts: number, random = Math.random) {
  const base = Math.min(15_000 * 4 ** Math.max(0, attempts - 1), 3_600_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

export async function processDueJobs(limit = 10): Promise<{ processed: number; failed: number }> {
  await import("./handlers"); // ensure handlers registered
  // Recover jobs stuck in "running" (worker crashed mid-job).
  await db
    .update(jobs)
    .set({ status: "pending", lockedAt: null })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, new Date(Date.now() - 5 * 60_000))));

  const claimed = await db.execute<{
    id: string;
    type: string;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
  }>(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
      ORDER BY run_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    )
    RETURNING id, type, payload, attempts, max_attempts`);

  let failed = 0;
  for (const job of claimed.rows) {
    const handler = handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job.payload, { id: job.id, attempts: job.attempts, maxAttempts: job.max_attempts });
      await db
        .update(jobs)
        // Secrets (e.g. password-reset tokens) are dropped from the payload once used.
        .set({ status: "succeeded", lockedAt: null, lastError: null, payload: sql`${jobs.payload} - 'secret'`, updatedAt: new Date() })
        .where(eq(jobs.id, job.id));
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      const hints = err as { retryable?: boolean; retryAfterMs?: number | null };
      const exhausted = job.attempts >= job.max_attempts || hints.retryable === false;
      const delay = Math.max(backoffMs(job.attempts), hints.retryAfterMs ?? 0);
      await db
        .update(jobs)
        .set({
          status: exhausted ? "failed" : "pending",
          lockedAt: null,
          lastError: message.slice(0, 2000),
          runAt: new Date(Date.now() + delay),
          // A job that will never run again must not keep secrets (e.g. one-time codes) around.
          ...(exhausted ? { payload: sql`${jobs.payload} - 'secret'` } : {}),
          updatedAt: new Date(),
        })
        .where(eq(jobs.id, job.id));
    }
  }
  return { processed: claimed.rows.length, failed };
}

/** Re-queue a failed job immediately (admin action). */
export async function retryJob(id: string) {
  await db
    .update(jobs)
    .set({ status: "pending", runAt: new Date(), maxAttempts: sql`${jobs.attempts} + 3`, updatedAt: new Date() })
    .where(and(eq(jobs.id, id), eq(jobs.status, "failed")));
}

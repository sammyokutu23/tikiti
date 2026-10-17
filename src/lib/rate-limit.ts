/**
 * Fixed-window in-memory rate limiter. Good enough for a single-process
 * prototype; production with several instances needs a shared store (Redis/PG).
 */
type Bucket = { count: number; resetAt: number };
const store = (globalThis as unknown as { __tikosokoRl?: Map<string, Bucket> }).__tikosokoRl ?? new Map<string, Bucket>();
(globalThis as unknown as { __tikosokoRl?: Map<string, Bucket> }).__tikosokoRl = store;

export function rateLimit(key: string, limit: number, windowMs: number): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const b = store.get(key);
  if (!b || b.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    if (store.size > 10_000) {
      for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
    }
    return { ok: true, retryAfterMs: 0 };
  }
  b.count++;
  return b.count <= limit ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: b.resetAt - now };
}

export function resetRateLimits() {
  store.clear();
}

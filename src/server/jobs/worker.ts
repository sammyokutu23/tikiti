import { expireStaleBookings } from "../bookings/lifecycle";
import { scheduleEventReminders } from "../email/notify";
import { reconcileMpesaPayments } from "../payments/mpesa";
import { runPlanMaintenance } from "../plans/apply";
import { closeEndedListings } from "../resale/listings";
import { processDueJobs } from "./queue";

let running = false;
let lastReminderScan = 0;
let lastPlanScan = 0;

/** One maintenance tick: release lapsed holds, reconcile overdue M-Pesa attempts, schedule reminders, then run due outbox jobs. */
export async function workerTick() {
  if (running) return;
  running = true;
  try {
    await expireStaleBookings();
    await reconcileMpesaPayments().catch((err) => console.error("[worker] M-Pesa reconciliation failed:", (err as Error).message));
    if (Date.now() - lastReminderScan > 5 * 60_000) {
      lastReminderScan = Date.now();
      await scheduleEventReminders().catch((err) => console.error("[worker] reminder scheduling failed:", (err as Error).message));
    }
    if (Date.now() - lastPlanScan > 60_000) {
      lastPlanScan = Date.now();
      await runPlanMaintenance().catch((err) => console.error("[worker] payment-plan maintenance failed:", (err as Error).message));
      await closeEndedListings().catch((err) => console.error("[worker] resale listing maintenance failed:", (err as Error).message));
    }
    for (let i = 0; i < 5; i++) {
      const r = await processDueJobs(10);
      if (r.processed < 10) break;
    }
  } catch (err) {
    console.error("[worker] tick failed:", (err as Error).message);
  } finally {
    running = false;
  }
}

export function startInlineWorker(intervalMs = 4000) {
  const g = globalThis as unknown as { __tikosokoWorker?: NodeJS.Timeout; __tikosokoWorkerTick?: () => Promise<void> };
  // The timer calls through globalThis so a dev hot reload swaps in the new code instead of running stale modules.
  g.__tikosokoWorkerTick = workerTick;
  if (g.__tikosokoWorker) return;
  g.__tikosokoWorker = setInterval(() => g.__tikosokoWorkerTick?.(), intervalMs);
  console.log(`[worker] inline outbox worker started (every ${intervalMs}ms)`);
}

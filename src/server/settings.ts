import { eq } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { platformSettings } from "@/db/schema";

/** Initial commission hypothesis: 5% of ticket face value. */
export const DEFAULT_COMMISSION_BPS = 500;
export const MAX_COMMISSION_BPS = 3000;
/** How long checkout holds inventory before releasing it. */
export const RESERVATION_MINUTES = 10;

export async function getCommissionBps(tx: Tx = db): Promise<number> {
  const [row] = await tx.select().from(platformSettings).where(eq(platformSettings.key, "commission_bps"));
  const v = row ? Number(row.value) : DEFAULT_COMMISSION_BPS;
  return Number.isInteger(v) && v >= 0 && v <= MAX_COMMISSION_BPS ? v : DEFAULT_COMMISSION_BPS;
}

export async function setCommissionBps(tx: Tx, bps: number, userId: string) {
  await tx
    .insert(platformSettings)
    .values({ key: "commission_bps", value: bps, updatedBy: userId })
    .onConflictDoUpdate({
      target: platformSettings.key,
      set: { value: bps, updatedBy: userId, updatedAt: new Date() },
    });
}

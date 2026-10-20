/**
 * Resale pricing and escrow rules (also in docs/RESALE.md).
 *  1. Sellers set any price (no cap), in whole shillings (M-Pesa has no cents).
 *  2. The buyer pays the price plus a 10% resale fee, rounded up to a whole shilling.
 *     The seller receives the full asking price.
 *  3. Seller money is held until after the event (24h for TikoSoko tickets, 72h for
 *     outside tickets, so buyers can report one that didn't work), then paid out by an admin.
 */
export const RESALE_FEE_BPS = 1000;
export const MIN_RESALE_PRICE_KES = 50;
/** Keeps price + fee inside the M-Pesa per-transaction limit (KES 250,000). */
export const MAX_RESALE_PRICE_KES = 220_000;
/** How long after the event ends a seller payout is held. */
export const PAYOUT_HOLD_HOURS = { platform: 24, external: 72 } as const;

export function resaleFeeMinor(priceMinor: number): number {
  return Math.ceil((priceMinor * RESALE_FEE_BPS) / 10_000 / 100) * 100;
}

export function resaleTotalMinor(priceMinor: number): number {
  return priceMinor + resaleFeeMinor(priceMinor);
}

export function payoutReleaseAt(kind: "platform" | "external", eventEndsAt: Date): Date {
  return new Date(eventEndsAt.getTime() + PAYOUT_HOLD_HOURS[kind] * 3_600_000);
}

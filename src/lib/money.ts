/** All money is integer minor units (KES cents). */

export function formatMoney(minor: number, currency = "KES", opts: { compact?: boolean } = {}): string {
  const major = minor / 100;
  if (minor === 0 && !opts.compact) return "Free";
  const hasCents = minor % 100 !== 0;
  return `${currency} ${major.toLocaleString("en-KE", {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Formats a signed/accounting amount; zero is "KES 0" rather than "Free". */
export function formatAmount(minor: number, currency = "KES"): string {
  const sign = minor < 0 ? "−" : "";
  const abs = Math.abs(minor);
  return `${sign}${currency} ${(abs / 100).toLocaleString("en-KE", {
    minimumFractionDigits: abs % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Parses a user-entered major amount ("1,500" / "1500.50") into minor units. */
export function parseMajorToMinor(input: string): number | null {
  const cleaned = input.replace(/[,\s]/g, "").replace(/^KES/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/**
 * Platform commission on face value, in basis points (500 = 5%).
 * Rounded half-up to the nearest minor unit. See docs/COMMISSION.md.
 */
export function calculateCommission(subtotalMinor: number, commissionBps: number): number {
  if (subtotalMinor <= 0 || commissionBps <= 0) return 0;
  return Math.floor((subtotalMinor * commissionBps + 5000) / 10000);
}

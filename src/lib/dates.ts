export const DEFAULT_TZ = "Africa/Nairobi";

type DateInput = Date | string | number;
const d = (v: DateInput) => (v instanceof Date ? v : new Date(v));

export function formatEventDate(v: DateInput, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-KE", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: tz,
  }).format(d(v));
}

export function formatTime(v: DateInput, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-KE", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  })
    .format(d(v))
    .toUpperCase();
}

export function formatDateTime(v: DateInput, tz = DEFAULT_TZ) {
  return `${formatEventDate(v, tz)}, ${formatTime(v, tz)}`;
}

export function formatShortDate(v: DateInput, tz = DEFAULT_TZ) {
  return new Intl.DateTimeFormat("en-KE", { day: "numeric", month: "short", timeZone: tz }).format(d(v));
}

/** {month: "Oct", day: "18"} for date badges. */
export function dateBadge(v: DateInput, tz = DEFAULT_TZ) {
  const parts = new Intl.DateTimeFormat("en-KE", { day: "numeric", month: "short", timeZone: tz }).formatToParts(d(v));
  return {
    month: parts.find((p) => p.type === "month")?.value ?? "",
    day: parts.find((p) => p.type === "day")?.value ?? "",
  };
}

/**
 * Converts a wall-clock "YYYY-MM-DDTHH:mm" in an IANA zone to a UTC Date.
 * Used for organizer form input (datetime-local is zone-less).
 */
export function zonedLocalToUtc(local: string, tz = DEFAULT_TZ): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const [, y, mo, da, h, mi] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, da, h, mi);
  const offset = tzOffsetMs(new Date(guess), tz);
  const first = guess - offset;
  // Re-check offset at the computed instant (DST edges; Nairobi has none).
  const offset2 = tzOffsetMs(new Date(first), tz);
  return new Date(guess - offset2);
}

/** Formats a UTC instant as "YYYY-MM-DDTHH:mm" wall-clock in a zone (for datetime-local). */
export function utcToZonedLocal(v: DateInput, tz = DEFAULT_TZ): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: tz,
  }).formatToParts(d(v));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

function tzOffsetMs(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function isValidTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

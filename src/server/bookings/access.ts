/**
 * Guest booking access. A booking reference alone never grants access; guests
 * use a signed, expiring link: base64url(bookingId.exp).hmac.
 * Links are emailed with the confirmation and can be re-requested by email.
 */
import { env } from "@/lib/env";
import { hmacBase64Url, safeEqual } from "@/lib/crypto";

const DAY = 86_400_000;

export function createBookingAccessToken(bookingId: string, eventEndsAt: Date, now = new Date()): string {
  // Valid until 30 days after the event (minimum 7 days from now).
  const exp = Math.max(eventEndsAt.getTime() + 30 * DAY, now.getTime() + 7 * DAY);
  const body = Buffer.from(`${bookingId}.${Math.floor(exp / 1000)}`).toString("base64url");
  return `${body}.${hmacBase64Url(env.accessLinkSecret, `booking-access:${body}`, 24)}`;
}

export function verifyBookingAccessToken(token: string | null | undefined, bookingId: string, now = new Date()): boolean {
  if (!token || token.length > 300) return false;
  const [body, sig] = token.split(".");
  if (!body || !sig) return false;
  if (!safeEqual(sig, hmacBase64Url(env.accessLinkSecret, `booking-access:${body}`, 24))) return false;
  const [id, expStr] = Buffer.from(body, "base64url").toString().split(".");
  return id === bookingId && Number(expStr) * 1000 > now.getTime();
}

export function bookingAccessCookieName(reference: string) {
  return `tk_bk_${reference.replace(/[^A-Z0-9]/gi, "")}`;
}

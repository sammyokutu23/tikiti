import { cookies } from "next/headers";
import type { Booking } from "@/db/schema";
import { getCurrentUser } from "../auth/session";
import { bookingAccessCookieName, createBookingAccessToken, verifyBookingAccessToken } from "./access";
import { canAccessBooking, getBookingByReference } from "./queries";

/** Remember a guest's access to their booking in this browser (httpOnly cookie). */
export async function rememberBookingAccess(booking: Booking, eventEndsAt: Date) {
  const token = createBookingAccessToken(booking.id, eventEndsAt);
  const jar = await cookies();
  jar.set(bookingAccessCookieName(booking.reference), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return token;
}

/**
 * Resolves a booking the current requester may access, or null.
 * Accepts a signed token from the URL (`?access=`) or the per-booking cookie.
 * Returns a token valid for building links (download URLs) on the page.
 */
export async function authorizeBooking(reference: string, queryToken?: string | null) {
  const booking = await getBookingByReference(reference);
  if (!booking) return null;
  const user = await getCurrentUser();
  const jar = await cookies();
  const cookieToken = jar.get(bookingAccessCookieName(reference))?.value;
  const token = [queryToken, cookieToken].find((t) => t && verifyBookingAccessToken(t, booking.id)) ?? null;
  if (!canAccessBooking(booking, user, token)) return null;
  return { booking, user, token, isOwner: !!user && booking.userId === user.id };
}

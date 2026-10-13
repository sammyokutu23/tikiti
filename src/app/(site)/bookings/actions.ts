"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { bookings, events } from "@/db/schema";
import type { FormState } from "@/lib/forms";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { audit } from "@/server/audit";
import { authorizeBooking } from "@/server/bookings/authorize";
import { queueEmail, queueTicketResend } from "@/server/email/queue";
import { getCurrentUser } from "@/server/auth/session";
import { z } from "zod";

export async function resendTicketsAction(_: FormState, fd: FormData): Promise<FormState> {
  const ref = String(fd.get("reference") ?? "");
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) return { error: "You don't have access to this booking." };
  if (access.booking.status !== "confirmed") return { error: "Tickets can only be resent for confirmed bookings." };
  if (!rateLimit(`resend:${access.booking.id}`, 3, 60 * 60_000).ok) return { error: "You've resent these tickets a few times already. Please try again in an hour." };
  await queueTicketResend(access.booking.id, access.booking.buyerEmail);
  revalidatePath(`/bookings/${ref}`);
  return { ok: true, message: `We're re-sending your tickets to ${access.booking.buyerEmail}.` };
}

/** Attach a guest booking to the logged-in account (requires a valid access link). */
export async function claimBookingAction(fd: FormData) {
  const ref = String(fd.get("reference") ?? "");
  const user = await getCurrentUser();
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!user || !access || access.booking.userId) return;
  await db.update(bookings).set({ userId: user.id, updatedAt: new Date() }).where(and(eq(bookings.id, access.booking.id), isNull(bookings.userId)));
  await audit(null, { actorUserId: user.id, action: "booking.claimed", entityType: "booking", entityId: access.booking.id });
  revalidatePath(`/bookings/${ref}`);
}

/** Emails a fresh access link. Same response whether or not the booking exists. */
export async function findBookingAction(_: FormState, fd: FormData): Promise<FormState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const reference = String(fd.get("reference") ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const fe: Record<string, string> = {};
  if (!z.email().safeParse(email).success) fe.email = "Enter the email you booked with";
  if (!/^TK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) fe.reference = "References look like TK-7KQ2-9XHM";
  if (Object.keys(fe).length) return { fieldErrors: fe, values: { email, reference } };
  const ip = await clientIp();
  if (!rateLimit(`find:${ip}`, 6, 15 * 60_000).ok) return { error: "Too many requests. Please try again later.", values: { email, reference } };

  const [b] = await db
    .select({ id: bookings.id, email: bookings.buyerEmail })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(and(eq(bookings.reference, reference), sql`lower(${bookings.buyerEmail}) = ${email}`));
  if (b && rateLimit(`find-booking:${b.id}`, 3, 60 * 60_000).ok) {
    await db.transaction((tx) => queueEmail(tx, { kind: "booking_access_link", bookingId: b.id, toEmail: b.email }));
  }
  return { ok: true, message: "If that booking exists, we've emailed a secure link to it. Check your inbox (and spam folder)." };
}

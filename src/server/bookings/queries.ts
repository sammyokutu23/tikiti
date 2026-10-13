import { and, asc, desc, eq, gt, inArray, lte, or } from "drizzle-orm";
import { db } from "@/db";
import {
  bookingItems,
  bookings,
  emailDeliveries,
  events,
  organizerProfiles,
  paymentTransactions,
  refunds,
  tickets,
  type Booking,
  type User,
} from "@/db/schema";
import { verifyBookingAccessToken } from "./access";

/**
 * Who may see a booking (and download its tickets):
 *  - the account that owns it,
 *  - a holder of a valid signed access link for it,
 *  - platform admins.
 * The organizer view of attendees is a separate, organizer-scoped path.
 * The booking reference alone is never sufficient.
 */
export function canAccessBooking(booking: Pick<Booking, "id" | "userId">, user: User | null, accessToken?: string | null) {
  if (user && booking.userId && booking.userId === user.id) return true;
  if (user?.role === "admin") return true;
  return verifyBookingAccessToken(accessToken, booking.id);
}

export async function getBookingByReference(reference: string) {
  if (!/^TK-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(reference)) return null;
  const [b] = await db.select().from(bookings).where(eq(bookings.reference, reference));
  return b ?? null;
}

export async function bookingDetail(bookingId: string) {
  const [row] = await db
    .select({ booking: bookings, event: events, organizerName: organizerProfiles.displayName })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(bookings.id, bookingId));
  if (!row) return null;
  const [items, tix, payments, refundRows, emails] = await Promise.all([
    db.select().from(bookingItems).where(eq(bookingItems.bookingId, bookingId)),
    db
      .select({ ticket: tickets, typeName: bookingItems.ticketTypeName })
      .from(tickets)
      .innerJoin(bookingItems, eq(bookingItems.id, tickets.bookingItemId))
      .where(eq(tickets.bookingId, bookingId))
      .orderBy(asc(bookingItems.ticketTypeName), asc(tickets.sequence)),
    db.select().from(paymentTransactions).where(eq(paymentTransactions.bookingId, bookingId)).orderBy(desc(paymentTransactions.createdAt)),
    db.select().from(refunds).where(eq(refunds.bookingId, bookingId)).orderBy(desc(refunds.createdAt)),
    db.select().from(emailDeliveries).where(eq(emailDeliveries.bookingId, bookingId)).orderBy(desc(emailDeliveries.createdAt)),
  ]);
  return { ...row, items, tickets: tix, payments, refunds: refundRows, emails };
}

export async function userBookings(userId: string, scope: "upcoming" | "past") {
  const now = new Date();
  return db
    .select({ booking: bookings, event: events })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(
      and(
        eq(bookings.userId, userId),
        inArray(bookings.status, ["confirmed", "refunded", "pending", "failed", "cancelled"]),
        scope === "upcoming" ? gt(events.endsAt, now) : lte(events.endsAt, now),
      ),
    )
    .orderBy(scope === "upcoming" ? asc(events.startsAt) : desc(events.startsAt));
}

/** Guest bookings made with this user's email that could be claimed via an access link. */
export async function findBookingsByEmail(email: string) {
  return db
    .select({ id: bookings.id, reference: bookings.reference, eventEndsAt: events.endsAt })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(and(eq(bookings.buyerEmail, email.toLowerCase()), or(eq(bookings.status, "confirmed"), eq(bookings.status, "refunded"))));
}

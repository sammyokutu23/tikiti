import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingItems, bookings, events, resaleListings, tickets, type Booking } from "@/db/schema";
import { newBookingReference } from "@/lib/crypto";
import { isUniqueViolation, UserError } from "@/lib/errors";
import { normalizeKenyanPhone } from "@/lib/utils";
import { expireStaleBookings } from "../bookings/lifecycle";
import { RESERVATION_MINUTES } from "../settings";
import { hasLiveCheckout } from "./listings";
import { resaleFeeMinor } from "./policy";

export const resaleCheckoutSchema = z.object({
  listingId: z.uuid(),
  buyerName: z.string().trim().min(2, "Enter your full name").max(120),
  buyerEmail: z.email("Enter a valid email address").trim().toLowerCase().max(200),
  buyerPhone: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const n = normalizeKenyanPhone(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "Enter a Kenyan mobile number, e.g. 0712 345 678" });
        return z.NEVER;
      }
      return n;
    }),
  idempotencyKey: z.string().min(16).max(100),
});

/**
 * Creates a pending booking for a resale listing, priced from the listing (never
 * from the browser): asking price + resale fee, no organizer commission. The
 * listing row lock plus the "one live checkout" check mean only one buyer pays
 * at a time. No inventory is held: the ticket already exists and is reissued on
 * confirmation (see ./lifecycle).
 */
export async function createResaleCheckout(input: z.infer<typeof resaleCheckoutSchema>, userId: string | null): Promise<Booking> {
  const [existing] = await db.select().from(bookings).where(eq(bookings.idempotencyKey, input.idempotencyKey));
  if (existing) {
    if (existing.resaleListingId !== input.listingId) throw new UserError("Checkout session mismatch. Please reload.");
    return existing;
  }
  await expireStaleBookings();

  try {
    return await db.transaction(async (tx) => {
      const [l] = await tx.select().from(resaleListings).where(eq(resaleListings.id, input.listingId)).for("update");
      if (!l || l.status !== "active" || !l.eventId) throw new UserError("This ticket is no longer for sale.");
      if (userId && l.sellerUserId === userId) throw new UserError("You can't buy your own listing.");
      const [ev] = await tx.select().from(events).where(eq(events.id, l.eventId));
      if (!ev || ev.status !== "published" || ev.endsAt <= new Date()) throw new UserError("This event has ended or was cancelled.");
      let ticketTypeId: string | null = null;
      if (l.kind === "platform") {
        const [t] = await tx.select().from(tickets).where(eq(tickets.id, l.ticketId!));
        if (!t || t.status !== "valid") throw new UserError("This ticket is no longer for sale.");
        ticketTypeId = t.ticketTypeId;
      }
      if (await hasLiveCheckout(tx, l.id)) throw new UserError("Someone else is paying for this ticket right now. Check back in about 10 minutes.");

      const fee = resaleFeeMinor(l.priceMinor);
      const [booking] = await tx
        .insert(bookings)
        .values({
          reference: newBookingReference(),
          eventId: l.eventId,
          userId,
          buyerName: input.buyerName,
          buyerEmail: input.buyerEmail,
          buyerPhone: input.buyerPhone,
          status: "pending",
          paymentStatus: "unpaid",
          // Nothing is counted on ticket_types for a resale, so there's no hold to release.
          inventoryState: "released",
          currency: l.currency,
          subtotalMinor: l.priceMinor,
          feesMinor: fee,
          discountMinor: 0,
          totalMinor: l.priceMinor + fee,
          commissionBps: 0,
          commissionMinor: 0,
          expiresAt: new Date(Date.now() + RESERVATION_MINUTES * 60_000),
          idempotencyKey: input.idempotencyKey,
          resaleListingId: l.id,
        })
        .returning();
      // TikoSoko tickets are reissued from this line; outside tickets have no ticket type.
      if (ticketTypeId) {
        await tx.insert(bookingItems).values({
          bookingId: booking.id,
          ticketTypeId,
          ticketTypeName: l.ticketTypeName,
          unitPriceMinor: l.priceMinor,
          quantity: 1,
          lineTotalMinor: l.priceMinor,
        });
      }
      return booking;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [b] = await db.select().from(bookings).where(eq(bookings.idempotencyKey, input.idempotencyKey));
      if (b) return b;
    }
    throw err;
  }
}

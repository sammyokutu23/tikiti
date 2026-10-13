import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { bookingItems, bookings, events, organizerProfiles, ticketTypes, type Booking } from "@/db/schema";
import { newBookingReference } from "@/lib/crypto";
import { calculateCommission } from "@/lib/money";
import { isUniqueViolation, UserError } from "@/lib/errors";
import { normalizeKenyanPhone } from "@/lib/utils";
import { holdInventory } from "../inventory";
import { getCommissionBps, RESERVATION_MINUTES } from "../settings";
import { confirmBooking, expireStaleBookings } from "./lifecycle";

export const MAX_TICKETS_PER_BOOKING = 20;

export const checkoutSchema = z.object({
  eventId: z.uuid(),
  items: z
    .array(z.object({ ticketTypeId: z.uuid(), quantity: z.coerce.number().int().min(0).max(50) }))
    .max(20),
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

export type CheckoutInput = z.infer<typeof checkoutSchema>;

/** Is this event currently purchasable by the public? */
export function isEventOnSale(e: { status: string; isHidden: boolean; endsAt: Date }, orgStatus: string, now = new Date()) {
  return e.status === "published" && !e.isHidden && orgStatus === "verified" && e.endsAt > now;
}

/**
 * Creates a pending booking with a time-limited inventory hold, priced from the
 * database (never from client input). Free orders are confirmed immediately.
 * Re-submitting with the same idempotency key returns the original booking.
 */
export async function createCheckout(input: CheckoutInput, userId: string | null): Promise<Booking> {
  const existing = await db.select().from(bookings).where(eq(bookings.idempotencyKey, input.idempotencyKey));
  if (existing[0]) {
    if (existing[0].eventId !== input.eventId) throw new UserError("Checkout session mismatch. Please reload.");
    return existing[0];
  }

  const lines = input.items.filter((i) => i.quantity > 0);
  if (lines.length === 0) throw new UserError("Select at least one ticket.");
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
  if (totalQty > MAX_TICKETS_PER_BOOKING) {
    throw new UserError(`You can book up to ${MAX_TICKETS_PER_BOOKING} tickets per order.`);
  }
  if (new Set(lines.map((l) => l.ticketTypeId)).size !== lines.length) throw new UserError("Duplicate ticket selection.");

  // Opportunistically release lapsed holds so they're available to this buyer.
  await expireStaleBookings();

  const [ev] = await db
    .select({ event: events, orgStatus: organizerProfiles.verificationStatus })
    .from(events)
    .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
    .where(eq(events.id, input.eventId));
  if (!ev || !isEventOnSale(ev.event, ev.orgStatus)) throw new UserError("This event is not available for booking.");
  if (ev.event.seatingMode !== "general_admission") throw new UserError("Reserved seating is not yet supported.");

  const types = await db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, input.eventId), inArray(ticketTypes.id, lines.map((l) => l.ticketTypeId))));
  const now = new Date();
  const priced = lines.map((l) => {
    const tt = types.find((t) => t.id === l.ticketTypeId);
    if (!tt || !tt.isActive) throw new UserError("One of the selected ticket types is no longer available.");
    if (tt.salesStartAt && tt.salesStartAt > now) throw new UserError(`${tt.name} sales haven't started yet.`);
    if (tt.salesEndAt && tt.salesEndAt <= now) throw new UserError(`${tt.name} sales have ended.`);
    if (l.quantity > tt.maxPerOrder) throw new UserError(`Maximum ${tt.maxPerOrder} ${tt.name} tickets per order.`);
    return { tt, quantity: l.quantity, lineTotal: tt.priceMinor * l.quantity };
  });

  const subtotal = priced.reduce((s, p) => s + p.lineTotal, 0);
  const commissionBps = await getCommissionBps();

  try {
    return await db.transaction(async (tx) => {
      await holdInventory(
        tx,
        input.eventId,
        priced.map((p) => ({ ticketTypeId: p.tt.id, quantity: p.quantity })),
      );
      const [booking] = await tx
        .insert(bookings)
        .values({
          reference: newBookingReference(),
          eventId: input.eventId,
          userId,
          buyerName: input.buyerName,
          buyerEmail: input.buyerEmail,
          buyerPhone: input.buyerPhone,
          status: "pending",
          paymentStatus: subtotal === 0 ? "not_required" : "unpaid",
          inventoryState: "held",
          subtotalMinor: subtotal,
          feesMinor: 0,
          discountMinor: 0,
          totalMinor: subtotal,
          commissionBps,
          commissionMinor: calculateCommission(subtotal, commissionBps),
          expiresAt: new Date(now.getTime() + RESERVATION_MINUTES * 60_000),
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      await tx.insert(bookingItems).values(
        priced.map((p) => ({
          bookingId: booking.id,
          ticketTypeId: p.tt.id,
          ticketTypeName: p.tt.name,
          unitPriceMinor: p.tt.priceMinor,
          quantity: p.quantity,
          lineTotalMinor: p.lineTotal,
        })),
      );
      if (subtotal === 0) return confirmBooking(tx, booking, { free: true });
      return booking;
    });
  } catch (err) {
    // A concurrent submit with the same idempotency key won the race.
    if (isUniqueViolation(err)) {
      const [b] = await db.select().from(bookings).where(eq(bookings.idempotencyKey, input.idempotencyKey));
      if (b) return b;
    }
    throw err;
  }
}

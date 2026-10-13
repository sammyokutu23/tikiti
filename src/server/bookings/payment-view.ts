import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { paymentTransactions, tickets, type Booking } from "@/db/schema";

export type BookingPaymentView = {
  status: string;
  paymentStatus: string;
  latestPayment: {
    status: string;
    failureReason: string | null;
    method: string;
    provider: string;
    /** Masked, e.g. "+254 712 ••• 678". */
    phone: string | null;
    sentAt: string;
  } | null;
  expiresAt: string;
  ticketCount: number;
};

function maskPhone(n: string | null) {
  if (!n || !/^254\d{9}$/.test(n)) return null;
  return `+254 ${n.slice(3, 6)} ••• ${n.slice(9)}`;
}

/** What the buyer's status page may see. No provider IDs, receipts or secrets. */
export async function bookingPaymentView(booking: Booking): Promise<BookingPaymentView> {
  const [p] = await db
    .select()
    .from(paymentTransactions)
    .where(eq(paymentTransactions.bookingId, booking.id))
    .orderBy(desc(paymentTransactions.createdAt))
    .limit(1);
  return {
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    latestPayment: p
      ? { status: p.status, failureReason: p.failureReason, method: p.method, provider: p.provider, phone: maskPhone(p.payerPhone), sentAt: p.createdAt.toISOString() }
      : null,
    expiresAt: booking.expiresAt.toISOString(),
    ticketCount: booking.status === "confirmed" ? await db.$count(tickets, eq(tickets.bookingId, booking.id)) : 0,
  };
}

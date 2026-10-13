/**
 * Commission & organizer ledger. Rules (also in docs/COMMISSION.md):
 *  1. Commission = round_half_up(face value subtotal × commission_bps / 10 000),
 *     using the rate snapshotted on the booking at checkout.
 *  2. Commission is deducted from organizer proceeds; buyers pay face value.
 *  3. A full refund reverses the commission for that booking.
 *  4. Payment processing costs are unknown with the mock provider and are not
 *     deducted; they will be recorded as `adjustment` entries once known.
 *  5. Balances are estimates. Nothing here moves or settles money.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { db } from "@/db";
import { bookings, events, ledgerEntries, type Booking } from "@/db/schema";

export async function recordSaleLedger(tx: Tx, booking: Booking, organizerId: string) {
  if (booking.subtotalMinor <= 0) return;
  await tx
    .insert(ledgerEntries)
    .values([
      {
        organizerId,
        eventId: booking.eventId,
        bookingId: booking.id,
        type: "ticket_sale",
        amountMinor: booking.subtotalMinor,
        description: `Ticket sale ${booking.reference}`,
      },
      {
        organizerId,
        eventId: booking.eventId,
        bookingId: booking.id,
        type: "platform_commission",
        amountMinor: -booking.commissionMinor,
        description: `Platform commission ${(booking.commissionBps / 100).toFixed(2)}% on ${booking.reference}`,
      },
    ])
    .onConflictDoNothing();
}

export async function recordRefundLedger(
  tx: Tx,
  args: { booking: Booking; organizerId: string; refundId: string; amountMinor: number; commissionReversedMinor: number },
) {
  const rows: (typeof ledgerEntries.$inferInsert)[] = [
    {
      organizerId: args.organizerId,
      eventId: args.booking.eventId,
      bookingId: args.booking.id,
      refundId: args.refundId,
      type: "refund",
      amountMinor: -args.amountMinor,
      description: `Refund ${args.booking.reference}`,
    },
  ];
  if (args.commissionReversedMinor > 0) {
    rows.push({
      organizerId: args.organizerId,
      eventId: args.booking.eventId,
      bookingId: args.booking.id,
      refundId: args.refundId,
      type: "commission_reversal",
      amountMinor: args.commissionReversedMinor,
      description: `Commission reversed on refund ${args.booking.reference}`,
    });
  }
  await tx.insert(ledgerEntries).values(rows).onConflictDoNothing();
}

export type FinancialSummary = {
  grossSalesMinor: number;
  commissionMinor: number;
  refundsMinor: number;
  commissionReversedMinor: number;
  adjustmentsMinor: number;
  /** Net platform commission after reversals. */
  netCommissionMinor: number;
  /** Gross − commission − refunds + reversals + adjustments. Estimated, unsettled. */
  estimatedProceedsMinor: number;
};

export async function financialSummary(filter: { organizerId?: string; eventIds?: string[] } = {}): Promise<FinancialSummary> {
  const conds = [];
  if (filter.organizerId) conds.push(eq(ledgerEntries.organizerId, filter.organizerId));
  if (filter.eventIds) {
    if (filter.eventIds.length === 0) return emptySummary();
    conds.push(inArray(ledgerEntries.eventId, filter.eventIds));
  }
  const rows = await db
    .select({ type: ledgerEntries.type, total: sql<string>`coalesce(sum(${ledgerEntries.amountMinor}),0)` })
    .from(ledgerEntries)
    .where(conds.length ? and(...conds) : undefined)
    .groupBy(ledgerEntries.type);
  const by = (t: string) => Number(rows.find((r) => r.type === t)?.total ?? 0);
  const gross = by("ticket_sale");
  const commission = -by("platform_commission");
  const refunds = -by("refund");
  const reversed = by("commission_reversal");
  const adjustments = by("adjustment");
  return {
    grossSalesMinor: gross,
    commissionMinor: commission,
    refundsMinor: refunds,
    commissionReversedMinor: reversed,
    adjustmentsMinor: adjustments,
    netCommissionMinor: commission - reversed,
    estimatedProceedsMinor: gross - commission - refunds + reversed + adjustments,
  };
}

function emptySummary(): FinancialSummary {
  return {
    grossSalesMinor: 0,
    commissionMinor: 0,
    refundsMinor: 0,
    commissionReversedMinor: 0,
    adjustmentsMinor: 0,
    netCommissionMinor: 0,
    estimatedProceedsMinor: 0,
  };
}

/** Cross-check: ledger totals must agree with booking snapshots (used in tests/admin). */
export async function reconcileOrganizer(organizerId: string) {
  const [snap] = await db
    .select({
      gross: sql<string>`coalesce(sum(${bookings.subtotalMinor}),0)`,
      commission: sql<string>`coalesce(sum(${bookings.commissionMinor}),0)`,
    })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(and(eq(events.organizerId, organizerId), inArray(bookings.status, ["confirmed", "refunded"])));
  return { grossMinor: Number(snap.gross), commissionMinor: Number(snap.commission) };
}

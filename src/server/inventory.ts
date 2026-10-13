/**
 * General-admission inventory. All changes are single guarded UPDATE statements
 * so concurrent checkouts can never push sold + reserved above capacity (the
 * CHECK constraint `ticket_types_no_oversell` is the final backstop).
 * Lines are always processed in ticket_type id order to avoid deadlocks.
 */
import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { ticketTypes } from "@/db/schema";
import { UserError } from "@/lib/errors";

export type InventoryLine = { ticketTypeId: string; quantity: number };

const sorted = (lines: InventoryLine[]) => [...lines].sort((a, b) => a.ticketTypeId.localeCompare(b.ticketTypeId));

export class InventoryUnavailableError extends UserError {
  constructor(message = "Sorry — those tickets just sold out.") {
    super(message, "sold_out", 409);
  }
}

/** Temporarily reserve units for a pending booking. */
export async function holdInventory(tx: Tx, eventId: string, lines: InventoryLine[]) {
  for (const line of sorted(lines)) {
    const rows = await tx
      .update(ticketTypes)
      .set({ reserved: sql`${ticketTypes.reserved} + ${line.quantity}`, updatedAt: new Date() })
      .where(
        and(
          eq(ticketTypes.id, line.ticketTypeId),
          eq(ticketTypes.eventId, eventId),
          eq(ticketTypes.isActive, true),
          sql`${ticketTypes.capacity} - ${ticketTypes.sold} - ${ticketTypes.reserved} >= ${line.quantity}`,
        ),
      )
      .returning({ id: ticketTypes.id });
    if (rows.length === 0) {
      const [tt] = await tx.select().from(ticketTypes).where(eq(ticketTypes.id, line.ticketTypeId));
      const left = tt ? Math.max(0, tt.capacity - tt.sold - tt.reserved) : 0;
      throw new InventoryUnavailableError(
        tt
          ? left === 0
            ? `${tt.name} is sold out.`
            : `Only ${left} ${tt.name} ticket${left === 1 ? "" : "s"} left.`
          : "That ticket type is no longer available.",
      );
    }
  }
}

/** Move held units to sold (payment verified while the hold was active). */
export async function commitHeldInventory(tx: Tx, lines: InventoryLine[]) {
  for (const line of sorted(lines)) {
    const rows = await tx
      .update(ticketTypes)
      .set({
        reserved: sql`${ticketTypes.reserved} - ${line.quantity}`,
        sold: sql`${ticketTypes.sold} + ${line.quantity}`,
        updatedAt: new Date(),
      })
      .where(and(eq(ticketTypes.id, line.ticketTypeId), gte(ticketTypes.reserved, line.quantity)))
      .returning({ id: ticketTypes.id });
    if (rows.length === 0) throw new Error(`Inventory hold missing for ticket type ${line.ticketTypeId}`);
  }
}

/** Release held units (hold expired or checkout cancelled). */
export async function releaseHeldInventory(tx: Tx, lines: InventoryLine[]) {
  for (const line of sorted(lines)) {
    await tx
      .update(ticketTypes)
      .set({ reserved: sql`GREATEST(${ticketTypes.reserved} - ${line.quantity}, 0)`, updatedAt: new Date() })
      .where(eq(ticketTypes.id, line.ticketTypeId));
  }
}

/**
 * Directly sell units without a hold — used when a payment is verified after the
 * hold already expired. Fails (and rolls back) if the units were resold.
 */
export async function acquireSoldInventory(tx: Tx, lines: InventoryLine[]) {
  for (const line of sorted(lines)) {
    const rows = await tx
      .update(ticketTypes)
      .set({ sold: sql`${ticketTypes.sold} + ${line.quantity}`, updatedAt: new Date() })
      .where(
        and(
          eq(ticketTypes.id, line.ticketTypeId),
          sql`${ticketTypes.capacity} - ${ticketTypes.sold} - ${ticketTypes.reserved} >= ${line.quantity}`,
        ),
      )
      .returning({ id: ticketTypes.id });
    if (rows.length === 0) throw new InventoryUnavailableError();
  }
}

/** Return sold units to the pool (refund before the event). */
export async function releaseSoldInventory(tx: Tx, lines: InventoryLine[]) {
  for (const line of sorted(lines)) {
    await tx
      .update(ticketTypes)
      .set({ sold: sql`GREATEST(${ticketTypes.sold} - ${line.quantity}, 0)`, updatedAt: new Date() })
      .where(eq(ticketTypes.id, line.ticketTypeId));
  }
}

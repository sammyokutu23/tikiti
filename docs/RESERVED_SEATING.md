# Reserved seating — boundary and design

**Status: not implemented.** Only general admission (GA) works end to end. Reserved seating
is deliberately *not* faked as "seat quantities".

## What exists today

- `events.seating_mode` enum (`general_admission` | `reserved_seating`). Checkout rejects any
  event that isn't GA (`createCheckout`).
- GA inventory is counter-based on `ticket_types` (`capacity`, `sold`, `reserved`). It changes
  only through guarded atomic `UPDATE`s and is backed by a `CHECK (sold + reserved <= capacity)`.
- Tickets are issued per booking item and unit (`tickets.booking_item_id`, `sequence`).

## Planned additions (no rewrite of GA required)

| Table / column          | Purpose |
|-------------------------|---------|
| `venue_layouts`         | A reusable seat map per venue (JSON geometry for rendering) |
| `venue_sections`        | Sections such as B1, C2, each with an optional price tier (ticket type) |
| `seats`                 | One row per physical seat: `section_id`, `row_label`, `seat_number`; unique per layout |
| `event_seats`           | Per-event seat inventory: `status` (`available` / `held` / `sold` / `blocked`), `hold_booking_id`, `hold_expires_at`; unique `(event_id, seat_id)` |
| `booking_items.seat_id` | Nullable; set for reserved-seat items (quantity = 1) |
| `tickets.event_seat_id` | Nullable, unique: binds a ticket to exactly one seat |

### Holds and conflict-free reservation

- Holding a seat is one guarded `UPDATE event_seats SET status='held', hold_booking_id=…,
  hold_expires_at=… WHERE event_id=… AND seat_id = ANY(…) AND status='available'`. Exactly N rows
  must update, otherwise the transaction rolls back. That gives atomic multi-seat holds without races.
- The same `expireStaleBookings()` job releases seats whose hold expired (`status='held' AND hold_expires_at < now()`).
- On confirmation, the move `held → sold` is guarded by `hold_booking_id = booking.id`. A late
  payment re-acquires seats only if they are still `available`, otherwise it auto-refunds
  (the same path as GA's `failBookingWithRefund`).
- Scanning shows the seat label, and validation stays server-side through `tickets`.

UI: a section map (as in the design reference) feeds a seat picker, which feeds the same
checkout, payment, ticket, PDF and email pipeline.

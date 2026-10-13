# Commission & ledger rules

Initial hypothesis: **5% (500 basis points)** of ticket face value. Admins change it at
`/admin/finance` (audit-logged). The rate lives in `platform_settings.commission_bps`.
It is not hard-coded anywhere else (`DEFAULT_COMMISSION_BPS` is only a fallback).

## Rules

1. **Base.** The commission is charged on the booking's face-value subtotal (`subtotal_minor`).
   Buyers pay face value. The prototype has no buyer fees (`fees_minor = 0`) and no discounts.
2. **Formula.** `commission = floor((subtotal × bps + 5000) / 10000)`, which rounds half-up to the cent.
   It is implemented once in `calculateCommission()` (`src/lib/money.ts`).
3. **Snapshot.** At checkout the rate and amount are stored on the booking (`commission_bps` and
   `commission_minor`). Changing the platform rate never changes existing bookings.
4. **Who pays.** The commission is deducted from organizer proceeds.
5. **Free tickets.** They carry no commission and create no ledger entries.
6. **Refunds.** A full refund reverses the booking's commission. The refund is recorded as a
   `refund` entry (−face value) plus a `commission_reversal` entry (+commission).
7. **Processing costs.** These are unknown with the mock provider and are not deducted. Once a
   real provider reports fees, record them as `adjustment` entries.
8. **Settlement.** Balances are estimates. Nothing in the app moves, splits or settles money.

## Ledger (`ledger_entries`, organizer perspective)

| type                  | sign | when                       |
|-----------------------|------|----------------------------|
| `ticket_sale`         | +    | booking confirmed (paid)   |
| `platform_commission` | −    | booking confirmed (paid)   |
| `refund`              | −    | booking refunded           |
| `commission_reversal` | +    | booking refunded           |
| `adjustment`          | ±    | manual / future fees       |

The unique constraint `(booking_id, refund_id, type)` uses `NULLS NOT DISTINCT`, so entries are
idempotent: duplicate callbacks never double-count.

**Estimated organizer proceeds** = gross − commission − refunds + commission reversed + adjustments.
`tests/authz-finance.test.ts` asserts this identity through sales, refunds and an event cancellation.

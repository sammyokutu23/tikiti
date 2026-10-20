# Resale marketplace

Fans can resell tickets they can't use: tickets bought on TikoSoko, and tickets bought on other
platforms (Mookh, Ticketsasa, the organizer directly…). Code lives in `src/server/resale/`.

## Rules

| | TikoSoko ticket | Outside ticket |
|---|---|---|
| Goes live | Immediately | After an admin reviews the ticket file and proof of purchase |
| On sale | Seller's ticket is **revoked**, buyer gets a **new ticket** (new code + QR) | Buyer downloads the seller's ticket file |
| Seller payout released | 24 h after the event ends | 72 h after the event ends |
| Buyer protection | Ticket can't be used twice (old QR scans as revoked) | Buyer can report a problem until the payout is released; admin refunds or pays the seller |

- **Price:** set freely by the seller (no cap), whole shillings, KES 50 to 220,000.
- **Fee:** the buyer pays the price + **10%**, rounded up to a whole shilling. The seller receives
  the full price. The organizer earns nothing on a resale and their reports are unaffected.
- **Payouts are manual:** an admin sends the money from the M-Pesa org portal and records the
  receipt at `/admin/resale → Payouts & disputes`. Nothing moves money automatically.

## How it plugs into bookings

A purchase is an ordinary `bookings` row with `resale_listing_id` set, so it reuses checkout,
M-Pesa (STK + reconciliation), the status page, refunds and emails unchanged:

- `createResaleCheckout` locks the listing and allows one live checkout per listing. No inventory
  is held (`inventory_state = released`), commission is 0, fees = the resale fee.
- `confirmBooking` hands resale bookings to `confirmResaleBooking`, which revokes and reissues
  (TikoSoko tickets), marks the listing sold and creates the held `resale_payouts` row. If the
  ticket can't be delivered (withdrawn, used, refunded, event over), it throws
  `InventoryUnavailableError`, and the payment is refunded automatically like a sold-out late payment.
- `refundBooking` cancels the seller's payout instead of writing organizer ledger entries.
- A partial unique index (`bookings_resale_confirmed_uq`) guarantees a listing sells once.
- Organizer reports and `reconcileOrganizer` exclude resale bookings. The reissued ticket still
  appears in the organizer's attendee list and scans normally.

## Outside tickets

- Files are validated by their bytes (PDF/JPG/PNG/WebP, max 2 MB each) and stored in
  `resale_documents` (Postgres), **not** the public image bucket. `/api/resale/documents/[id]`
  serves them to admins, the seller, and (ticket file only) the buyer of a confirmed purchase.
- On approval the admin either links the listing to an existing TikoSoko event or creates an
  **outside event**: an `events` row with `is_external = true`, hidden from all public listings,
  owned by the system organizer profile `tikosoko-resale` (created on first use; its user has an
  `.invalid` email so nobody can sign in as it).

## Lifecycle

```
platform: active ──paid──▶ sold
external: pending_review ──approve──▶ active ──paid──▶ sold      pending_review ──reject──▶ rejected
active / pending_review ──seller withdraws──▶ cancelled
active / pending_review ──event over or cancelled, ticket used/refunded──▶ closed  (worker, every minute)

payout: held ──release time passed, admin records receipt──▶ paid
held ──buyer reports problem──▶ disputed ──admin: pay seller──▶ held
                                         └─admin: refund buyer──▶ cancelled (booking refunded)
```

## Emails

`booking_confirmation` (buyer, TikoSoko ticket), `resale_purchase_confirmed` (buyer, outside
ticket), `resale_sold` (seller) and `resale_listing_reviewed` (seller, approved or rejected).

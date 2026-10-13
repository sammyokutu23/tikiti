# Architecture

A **modular monolith**: one Next.js 16 app (App Router, TypeScript), PostgreSQL as the source of
truth, and Drizzle ORM. Domain logic lives in `src/server/*`. Pages, server actions and route
handlers are thin and call into it.

```
src/
  db/schema.ts            all tables, enums, constraints, indexes
  lib/                    money, dates (TZ), crypto/IDs, rate limit, env, form helpers
  server/
    auth/                 password hashing, DB sessions, guards (role/ownership)
    events/               public discovery queries, organizer mutations (zod-validated)
    inventory.ts          atomic GA holds/commits/releases
    bookings/             checkout, state machine, refunds/cancellation, guest access tokens
    payments/             provider interface, mock + Daraja providers, webhook/callback processing, M-Pesa reconciliation (mpesa.ts)
    tickets/              QR signing/parsing, check-in, PDF data loaders
    pdf/ticket-pdf.ts     pdf-lib renderer (A4, one page per ticket)
    email/                outbox queue, transports (resend/dev-capture/smtp/disabled), templates,
                          Resend webhooks, triggers (notify.ts), admin tools — see docs/EMAIL.md
    jobs/                 transactional outbox + worker
    ledger.ts             commission & organizer ledger
    organizers/           onboarding/verification, reports
    storage.ts            image upload validation + storage driver
    audit.ts              audit log writer
  app/                    routes (customer, organizer, admin, API)
```

## Key flows

**Checkout.** `createCheckout` runs in one transaction. It prices from the DB, places guarded
`UPDATE ticket_types SET reserved = reserved + n WHERE capacity - sold - reserved >= n` holds
(lines locked in id order), inserts the booking and its items with snapshots, and sets
`expires_at = now + 10 min`. The idempotency key (unique) makes double-submits return the same
booking. A free order is confirmed in the same transaction.

**Payment.**
1. `startPayment` creates a `payment_transactions` row (unique idempotency key) and calls
   `provider.createPayment`.
2. The customer is redirected to the provider. In the prototype that's `/pay/mock/<ref>`.
3. The provider POSTs a signed callback to `/api/webhooks/payments/<provider>`. The mock provider
   calls the same `handlePaymentWebhook` function directly.
4. The browser lands on `/checkout/<ref>/status`, which only **polls**. The redirect itself
   confirms nothing.

M-Pesa via Daraja (`MPESA_PROVIDER=daraja`) skips steps 2–3. `startMpesaPayment` sends an STK
Push, and the customer enters their PIN in the official M-Pesa prompt on their phone. Safaricom
then POSTs an unsigned callback to `/api/payments/stk/callback/<token>`. That callback is
verified with an STK status query before it reaches the shared `applyPaymentResult`. Missed
callbacks are reconciled by the worker. See [MPESA.md](MPESA.md).

**Webhook processing** (`handlePaymentWebhook` → `applyPaymentResult`, shared with M-Pesa):
1. Verify the signature. Rejected callbacks are logged too.
2. Insert into `payment_events`, which is unique on `(provider, provider_event_id)`, so duplicates
   are no-ops.
3. Lock the payment and booking rows.
4. Check that amount and currency match, and that a receipt isn't reused. A mismatch moves the payment to `reconciliation_required` instead of confirming.
5. Apply the state machine:
   - A failure never overrides a success.
   - A success on a pending booking confirms it.
   - A success after expiry re-acquires inventory, or auto-refunds if it's gone.
   - A second success for an already-paid booking is auto-refunded.

**Confirmation** (`confirmBooking`, all in one transaction): commit inventory, issue one ticket
per unit (unique `(booking_item_id, sequence)`), write ledger entries, insert the email delivery
and its outbox job, and write an audit record. Idempotent.

**Delivery.** The outbox worker (`jobs`, `FOR UPDATE SKIP LOCKED`, exponential backoff with jitter,
at most 6 attempts, permanent errors stop immediately) renders the PDF and sends the email *after*
commit, through Resend with an Idempotency-Key per delivery. Resend webhooks update the status
(delivered / bounced / complained) and the suppression list. A PDF or provider failure only fails that
job. Bookings and tickets are never rolled back. Admins can retry or resend at
`/admin/operations`; customers can resend from their booking page (rate-limited). Neither path
can charge again or create tickets.

**Expiry.** `expireStaleBookings()` runs on every worker tick, before each checkout, and on status
polls. It uses `FOR UPDATE SKIP LOCKED` and releases holds exactly once (`inventory_state` held → released).

**Check-in.** The QR payload is `TKT1.<code>.<HMAC>`. `<code>` is 16 random characters (~78 bits);
there's no PII and nothing sequential. The scanner API checks that the caller owns the event,
then `scanTicket` verifies the signature, locks the ticket row and decides from the DB:
accepted / already_checked_in / refunded / revoked / wrong_event / not_confirmed / invalid.
Every attempt is logged in `check_ins` with the scanner's identity.

## Authorization model

- **Identity (Clerk).** `src/proxy.ts` runs `clerkMiddleware()` only to establish the session.
  `getCurrentUser()` maps the Clerk user to the local `users` row by `clerk_user_id`. On first
  sign-in, `resolveLocalUser` links an existing local account only if Clerk reports the email
  as **verified**; otherwise it creates a new *customer*. Roles, status (suspension), bookings
  and organizer data stay in Postgres, and every authorization check below is unchanged.
  Legacy `sessions`, `password_reset_tokens` and `users.password_hash` are no longer used; they
  were kept rather than dropped (non-destructive).
- **Customers.** Booking pages and PDFs require that the user owns the booking, holds a valid
  signed guest link (`?access=` or a per-booking httpOnly cookie), or is an admin. A reference
  alone is never enough (`canAccessBooking`).
- **Organizers.** Every organizer page, action and API resolves the event through
  `requireOwnedEvent`. A mismatch returns 404, not 403, to avoid leaking existence. Reports always
  filter by the caller's own event ids.
- **Publishing.** Requires `organizer_profiles.verification_status = 'verified'` **and** the
  `organizer` role. Only admin verification grants that role; applying does not.
- **Admins.** `/admin/*` returns 404 for everyone else. Sensitive actions write `audit_logs`.

## Data integrity

- Money is integer minor units (KES cents), with CHECKs for non-negative amounts and
  `total = subtotal + fees − discount`.
- Timestamps are `timestamptz` (UTC). Events carry an IANA zone (default `Africa/Nairobi`) used
  for display and organizer input.
- Unique constraints: emails (case-insensitive), slugs, booking references, ticket codes, provider
  references, idempotency keys, webhook event ids, email dedupe keys, ledger idempotency.

## Background work in development

`src/instrumentation.ts` starts an in-process worker every 4 s (`JOBS_INLINE_WORKER=true`).
In production, set it to `false` and run `npm run worker` as its own process.

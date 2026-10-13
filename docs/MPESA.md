# M-Pesa payments (Safaricom Daraja: M-Pesa Express / STK Push)

The customer chooses M-Pesa, checks their phone number and taps **Pay with M-Pesa**. Safaricom
sends a payment prompt to their phone, and they enter their PIN **in the official M-Pesa
prompt**. Tikiti never asks for, receives or stores an M-Pesa PIN. The booking is confirmed only
after Tikiti has verified evidence from Safaricom. Then tickets are issued, the PDF is generated
and the email is sent, through the same pipeline as every other booking.

Source of truth: the official Daraja docs at [developer.safaricom.co.ke](https://developer.safaricom.co.ke/)
(Authorization, M-Pesa Express Simulate, M-Pesa Express Query).

## How it fits the existing system

| Concern | Where |
|---|---|
| Method → provider routing (`mpesa` → Daraja, `card` → its own provider) | `src/server/payments/registry.ts`, `src/lib/env.ts` |
| Configuration and validation (sandbox/production URLs, live switch) | `src/server/payments/providers/daraja/config.ts` |
| HTTP client: OAuth token cache, STK Push, STK Query, outcome classification | `src/server/payments/providers/daraja/client.ts` |
| Callback parsing, redaction, result-code meanings | `src/server/payments/providers/daraja/callback.ts` |
| Initiation, callback verification, reconciliation, admin resolution | `src/server/payments/mpesa.ts` |
| Shared "apply a verified result exactly once" (also used by the mock provider) | `applyPaymentResult` in `src/server/payments/service.ts` |
| Callback route | `src/app/api/payments/stk/callback/[token]/route.ts` |
| Booking confirmation, tickets, ledger, email outbox (unchanged) | `confirmBooking` in `src/server/bookings/lifecycle.ts` |
| Customer status page | `src/app/(site)/checkout/[ref]/status/` |
| Admin reconciliation UI | `/admin/operations` → "M-Pesa payments needing attention" |

There are no new payment or booking tables. Migration `drizzle/0004_daraja_payments.sql` only
adds to the schema:

- **New enum values:**
  - `payment_status` gains `expired` and `reconciliation_required`.
  - `refund_status` gains `manual_required`.
- **New columns on `payment_transactions`:** `merchant_request_id`, `provider_receipt`
  (unique), `provider_result_code` and `provider_result_desc`, plus the status-check bookkeeping
  columns.
- **New column on `payment_events`:** `kind`.
- **New index:** a partial unique index allowing **one created/pending Daraja attempt per
  booking**.

## Payment states

```
created ──STK accepted──▶ pending ──verified result──▶ succeeded | failed | cancelled | expired
   │                         └── still unverifiable after 6 status checks ──▶ reconciliation_required
   └── Daraja never answered the request (timeout) ── after 2 min ──▶ reconciliation_required
```

- **Booking state is separate from payment state.** A failed, cancelled or expired attempt
  leaves the booking `pending`, so the hold is kept and the customer can retry.
- **Holds are protected during payment.** An accepted STK Push extends the hold to at least
  3 minutes, capped at 25 minutes after checkout, so it can't lapse while the customer types
  their PIN.
- **Result codes are mapped as follows:**
  - `0` → succeeded.
  - `1032` → cancelled.
  - `1037` and `1019` → expired.
  - Everything else → failed, with a customer-friendly message. Examples: `1` (insufficient
    balance), `2001` (wrong PIN), `17` (repeat within 2 minutes).

## Safeguards

- **Server-side amount.** The STK amount is always `booking.total_minor / 100`, never a value
  from the browser.
  - Totals must be whole shillings, so ticket prices are now validated as whole KES.
  - Totals must be KES 250,000 or less.
- **No duplicate prompts:**
  - The same click (idempotency key) returns the same attempt.
  - A second tab or click while a prompt is open is redirected to that attempt, enforced by the
    database unique index.
  - Rate limits are 6 attempts per booking and 6 per phone number every 10 minutes, on top of
    the per-IP limit.
- **Uncertain outcomes are never retried blindly.** On a timeout or an unreadable Daraja
  response, the attempt stays `created`, which blocks new prompts.
  - A late callback for it is matched by phone and amount, and only when exactly one candidate
    matches.
  - After 2 minutes the attempt becomes `reconciliation_required`, which unblocks retries and is
    shown to admins.
- **Definitive rejections are safe to retry.** Examples: auth failure, invalid request,
  rate-limited or "busy". No prompt was sent, so the customer gets a clear message.
- **Callbacks are untrusted.** Safaricom does not sign them, so Tikiti does not pretend to verify
  a signature. Instead, each callback must:
  1. Arrive on a secret, unguessable URL path (`DARAJA_CALLBACK_TOKEN`), plus an optional IP
     allowlist.
  2. Pass strict structure validation. A success callback without an amount and receipt is
     rejected.
  3. Match a stored `CheckoutRequestID` and `MerchantRequestID`.
  4. Be confirmed by an **STK status query** (`DARAJA_VERIFY_CALLBACKS=true`, the default). The
     authenticated query wins over the callback if they disagree.
  5. Have an amount equal to the stored amount, with a receipt number never used by another
     payment (a unique constraint). Otherwise the payment goes to `reconciliation_required`.
- **Exactly once.** Row locks, state checks and unique constraints ensure duplicate or replayed
  callbacks and status queries can never:
  - confirm twice,
  - issue extra tickets,
  - add ledger or commission rows twice,
  - or send uncontrolled emails.
- **Prompt acknowledgement.** The callback route stores a redacted copy, queues verification
  in the transactional outbox, and replies `{"ResultCode":0,"ResultDesc":"Accepted"}`.
  Processing runs right after the response, with the worker as a fallback that retries with
  backoff.
- **Late success after the hold expired.** Inventory is re-acquired if available, and the
  booking is confirmed. Otherwise the booking becomes `failed`, and a refund is created and
  flagged **Manual reversal** for an admin. Money is never silently kept.
- **Missed callbacks.** The worker queries Daraja for attempts with no result: first after
  90 seconds, then backing off (1 m, 2 m, 5 m, 15 m, 1 h).
  - Attempts are claimed so that parallel workers never query the same payment twice.
  - "Still processing" and timeouts are never treated as success or failure.
  - After 6 checks the attempt goes to `reconciliation_required` and automatic queries stop.
- **No secrets or PINs in logs.** Consumer keys, secrets, passkeys and tokens are never logged.
  Stored callbacks keep IDs, the result, amount, receipt and a **masked** phone number. The
  account balance is dropped.
- **Separate sandbox and production.** `DARAJA_ENV` selects the base URL. Production also needs
  `DARAJA_LIVE_PAYMENTS_ENABLED=true`, refuses the sandbox shortcode, and requires an HTTPS
  callback.

Email or PDF failures never touch the payment. The email outbox retries with backoff, and admins
can resend from `/admin/operations`. Free bookings never call Daraja.

## Environment variables

See `.env.example`. All of these are server-only, and none use the `NEXT_PUBLIC_` prefix.

| Variable | Notes |
|---|---|
| `MPESA_PROVIDER` | `daraja` to use M-Pesa Express (default `mock`). |
| `CARD_PROVIDER` | `mock` or `disabled`. Defaults to `disabled` in Daraja production. |
| `DARAJA_ENV` | `sandbox` or `production`. |
| `DARAJA_CONSUMER_KEY`, `DARAJA_CONSUMER_SECRET` | From your Daraja app. |
| `DARAJA_SHORTCODE` | BusinessShortCode: the Paybill, or the Store/HO number for a Till. |
| `DARAJA_PARTY_B` | Empty for Paybill (uses the shortcode). The **Till number** for Buy Goods. |
| `DARAJA_PASSKEY` | Lipa Na M-Pesa Online passkey. |
| `DARAJA_TRANSACTION_TYPE` | `CustomerPayBillOnline` (Paybill) or `CustomerBuyGoodsOnline` (Till). |
| `DARAJA_CALLBACK_URL` | `https://<your-domain>/api/payments/stk/callback` (no token). |
| `DARAJA_CALLBACK_TOKEN` | At least 24 URL-safe characters, e.g. `openssl rand -hex 24`. Appended as the last path segment. |
| `DARAJA_TIMEOUT_MS` | Per-request timeout. Default 15000. |
| `DARAJA_VERIFY_CALLBACKS` | Default `true`. Leave it on. |
| `DARAJA_CALLBACK_ALLOWED_IPS` | Optional allowlist. Only use it behind a proxy that sets `X-Forwarded-For` reliably. |
| `DARAJA_LIVE_PAYMENTS_ENABLED` | Must be `true` for `DARAJA_ENV=production`. |

The URL sent to Safaricom is `DARAJA_CALLBACK_URL + "/" + DARAJA_CALLBACK_TOKEN`. Developers
report that Daraja rejects callback URLs containing some keywords, such as "mpesa", so this
route avoids them.

## Sandbox setup

1. Create an account at [daraja.safaricom.co.ke](https://daraja.safaricom.co.ke/).
2. Under **My Apps**, create a sandbox app with the **M-Pesa Express Sandbox** product. Copy the
   Consumer Key and Secret.
3. Open the M-Pesa Express **simulator → test data** for the sandbox shortcode (`174379`) and
   its **passkey**.
4. Expose your local server over HTTPS so Safaricom can reach the callback, for example
   `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Set `APP_URL` to that
   address.
5. In `.env`:
   ```
   MPESA_PROVIDER=daraja
   DARAJA_ENV=sandbox
   DARAJA_CONSUMER_KEY=…            DARAJA_CONSUMER_SECRET=…
   DARAJA_SHORTCODE=174379          DARAJA_PASSKEY=<sandbox passkey>
   DARAJA_TRANSACTION_TYPE=CustomerPayBillOnline
   DARAJA_CALLBACK_URL=https://<tunnel-host>/api/payments/stk/callback
   DARAJA_CALLBACK_TOKEN=<openssl rand -hex 24>
   ```
6. Restart `npm run dev`, then run `npm run db:migrate` if you haven't.
7. Open `/admin/operations`. The header should read `M-Pesa: daraja (sandbox)`, with no
   configuration warning.
8. Buy a ticket and choose M-Pesa:
   - Use a Safaricom number you control, or the simulator's test number.
   - The status page says **Check your phone**.
   - Complete or cancel the prompt and watch the page update.
   - `/admin/operations` lists the callback and the status query that verified it.
9. With no tunnel, callbacks can't arrive. After about 90 seconds the worker's status query
   still settles the payment, which also exercises the missed-callback path.

## Going live

1. **Merchant prerequisites:**
   - A live **Paybill or Till** (apply via M-PESABusiness@Safaricom.co.ke).
   - Access to the **M-Pesa Org Portal**, with a Business Administrator or Business Manager
     operator. The Go Live OTP goes to that operator's Safaricom line.
2. In the Daraja portal, open **Go Live** and submit your shortcode, organisation name and
   operator username. After approval, Safaricom emails the production details, including the
   passkey, and moves your app to production with new keys.
3. Configure production secrets in your host's secret store, never in git:
   - `DARAJA_ENV=production`
   - production key, secret and passkey
   - your shortcode and Party B
   - the transaction type matching Paybill or Till
   - a public **HTTPS** `DARAJA_CALLBACK_URL`
   - a fresh `DARAJA_CALLBACK_TOKEN`
4. Run the worker as its own process: `npm run worker` with `JOBS_INLINE_WORKER=false`.
5. Only when ready, set `DARAJA_LIVE_PAYMENTS_ENABLED=true`. Run one small real transaction you
   are authorized to make. Check it end to end: prompt → callback → status query → tickets
   email → org-portal statement.
6. To switch environments, change `DARAJA_ENV` **together with** all credentials and the
   shortcode, then restart. The server refuses obviously mixed configurations, such as the
   sandbox shortcode in production.

## Monitoring and reconciliation

`/admin/operations` → **M-Pesa payments needing attention** lists:

- **Attempts that need a decision:** attempts in `reconciliation_required`, and attempts still
  `created` or `pending` after 10 minutes. You can:
  - **Check status now** (one STK query).
  - **Mark paid** (requires the M-Pesa receipt from the org-portal statement). The booking is
    then confirmed through the once-only path, or refunded if the tickets are gone.
  - **Mark not paid**.
- **Manual reversals:** late or duplicate payments that must be refunded. Reverse them in the
  org portal, then enter the reversal transaction ID.
- **Unmatched successful callbacks:** money received for an unknown `CheckoutRequestID`. Find the
  customer by receipt and amount in the org portal.

Every transition is written to `audit_logs`, for example:
`payment.stk_sent`, `payment.stk_uncertain`, `payment.succeeded`, `payment.callback_contradicted`,
`payment.reconciliation_required`, `refund.manual_required`.

## Tests

`npm test` runs `tests/mpesa.test.ts` against a **fake Daraja server** (mocked `fetch`). It
covers:

- **Initiation:** correct request fields, password and timestamp, token caching; invalid phone;
  OAuth failure; rejected and busy initiation; duplicate initiation; initiation timeout followed
  by a matched orphan callback.
- **Callback outcomes:** cancellation; failure; success; duplicate callbacks; unknown checkout
  ID; amount mismatch; forged token; a callback contradicted by the query.
- **Missing or uncertain results:** a missed callback reconciled by status queries; a query
  timeout leading to flagging and admin resolution.
- **After the hold expired:** late success, both confirmed and sold out with a manual refund.
- **After confirmation:** PDF failure and email failure, each with a retry.
- **Exactly-once checks:** no duplicate tickets, ledger rows or commission.

These tests do **not** contact Safaricom. A real sandbox run needs the credentials and the public
callback URL described above.

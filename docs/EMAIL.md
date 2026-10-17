# Email delivery (Resend)

TikoSoko sends transactional email only, through one service (`src/server/email/`). In production the
transport is [Resend](https://resend.com/docs/send-with-nodejs). There is no marketing or newsletter
email, so no marketing-consent or unsubscribe flow exists. If you add marketing email later, build it
separately with consent, an unsubscribe link, and Resend's Audiences/Topics.

## What gets sent

| Kind | Trigger | Recipient | Critical* |
|---|---|---|---|
| `booking_confirmation` | Booking confirmed after a **verified** payment (or a free booking) | Buyer | ✓ |
| `booking_access_link` | Buyer asks for their booking link again (`/bookings/find`) | Buyer | ✓ |
| `payment_failed` | M-Pesa reports a failed or cancelled payment *later* (callback, status query or admin) | Buyer | |
| `payment_review` | Payment needs manual confirmation (`reconciliation_required`): "don't pay again" | Buyer | |
| `booking_refunded` / `event_cancelled` | Refund started / event cancelled | Buyer | ✓ |
| `refund_completed` | Refund settled (provider-confirmed or manual M-Pesa reversal recorded) | Buyer | ✓ |
| `event_reminder` | About 24 h before the start (worker scan, event's own time zone) | Buyer | |
| `event_updated` | Organizer changes the date/time, venue or map pin of a published event | Buyer | ✓ |
| `organizer_event_published` | First publication | Organizer contact email | |
| `organizer_event_attention` | Admin hides the event (moderation) | Organizer | |
| `organizer_new_sale` | Every confirmed booking | Organizer | |
| `organizer_event_cancelled` | Event cancelled | Organizer | |
| `account_email` | Clerk verification / password reset / sign-in emails (opt-in, see below) | Account holder | ✓ |

\*A spam complaint suppresses only the non-critical kinds. A hard bounce suppresses everything to that
address, because the mailbox doesn't exist.

## How a ticket email is produced

```
payment callback → verified → applyPaymentResult → confirmBooking (one DB transaction:
  tickets issued + ledger + email_deliveries row + outbox job)   ← nothing is sent before this commits
        ↓ worker / after()
  email.send job → load booking + ticket records → render PDF (pdf-lib, one page per ticket,
  each with its own code and signed QR) → validate PDF → Resend (Idempotency-Key) → store email id
        ↓ Resend webhooks
  accepted → delivered | delivery_delayed | bounced | complained | failed | suppressed
```

- **What triggers the email:** only the existing verified-payment path (`confirmBooking`). Starting a
  payment, an accepted STK Push, a return to the success page, a pending status or a receipt typed by a
  customer never trigger it.
- **No delay to Safaricom:** the M-Pesa callback is acknowledged first. The PDF is rendered and the email
  sent afterwards in the job queue, so a slow PDF or email never delays the callback.
- **Email problems never touch the payment:** a PDF or Resend failure fails only the email job. The
  booking stays paid and confirmed, the tickets stay issued, and nothing is charged again.
- **Large PDFs:** a PDF over `EMAIL_MAX_ATTACHMENT_BYTES` (default 10 MB; Resend allows 40 MB including
  base64 encoding) isn't attached. The email then says "Download tickets" and links to the booking page.
- **The ticket link** is `/bookings/<ref>?access=<token>`. The token is HMAC-signed, bound to that
  booking, and expires 30 days after the event. The reference alone never grants access.

## Statuses, retries and idempotency

`email_deliveries.status`:

| Status | Meaning |
|---|---|
| `queued` | Waiting for the worker |
| `sending` | Being sent now |
| `retry_pending` | A transient error happened; it will retry |
| `accepted` | Resend took the email. This does **not** mean it reached the inbox. |
| `delivered` | The recipient's mail server accepted it (from a webhook) |
| `delivery_delayed` | The recipient's mail server is deferring it |
| `bounced` | The recipient's mail server rejected it |
| `complained` | The recipient marked it as spam |
| `suppressed` | The address is on the suppression list, so it wasn't sent |
| `failed` | Permanent failure, or retries exhausted |
| `skipped` | No longer relevant, e.g. "payment failed" when the booking has since been paid |

Plus `sent` (SMTP) and `captured` (dev mailbox).

**Duplicate protection** works at several levels:
- **One email per event:** `dedupe_key` is unique, e.g. `booking_confirmation:<bookingId>`. Duplicate
  payment callbacks therefore produce one email.
- **Claimed once:** the job claims the delivery with a conditional update. A delivery that already
  reached Resend is never sent again by the job.
- **Retries are deduplicated by Resend:** every request carries `Idempotency-Key: tikiti-email-<deliveryId>`.
  The rendered payload is deterministic (fixed PDF dates, link token anchored to the delivery), so a
  retry after a timeout or a lost response comes back from Resend as the same email, not a second one.
- **Uncertain results:** Resend honours the key for 24 hours. A timeout or 5xx is retried inside that
  window. An uncertain attempt older than about 23 hours is marked `failed` instead of being sent blindly.

**How each error is handled:**

| Error | Category | Retried? |
|---|---|---|
| Missing or invalid key, unverified sender | `config` | No. Fix it, then use *Retry config failures*. |
| Validation, invalid recipient | `rejected` / `invalid_recipient` | No |
| 429 rate limit | `rate_limited` | Yes, after at least the `Retry-After` delay |
| Daily or monthly quota | `quota` | Yes, after about an hour |
| Timeout, network error, 5xx | `uncertain` / `provider_unavailable` | Yes, with the same key |
| Idempotency conflict | `idempotency_conflict` | No. An operator checks Resend first. |

Backoff is 15 s → 1 m → 4 m → 16 m → 60 m with ±20 % jitter, 6 attempts in total.

## Webhooks

**Endpoint:** `POST /api/webhooks/resend`. Subscribe to `email.sent`, `email.delivered`,
`email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`.

- **Authentication:** Resend signs webhooks with Svix (Standard Webhooks). The handler verifies the
  `svix-id`/`svix-timestamp`/`svix-signature` HMAC against `RESEND_WEBHOOK_SECRET` with the SDK's
  `webhooks.verify`, which rejects timestamps more than 5 minutes off. Invalid requests get 401. If the
  secret isn't set, the endpoint returns 503.
- **Idempotent:** each webhook id is stored once (`email_provider_events`). Replays are acknowledged and
  ignored.
- **Order-independent:** status only moves forward. A late `email.sent` can't undo `delivered`, and
  bounces and complaints are final.
- **Events that arrive early:** an event can arrive before the send call returns the email id. It's kept
  and applied once the id is stored.
- **Suppression:** a hard bounce or complaint adds the address to `email_suppressions`, and later
  automatic emails respect it. Admins can lift an entry.
- **What's stored:** only the bounce type, the message and the failure reason. Recipient lists and
  bodies are not kept.

## Account emails (Clerk)

Sign-up, verification codes and password reset are handled by **Clerk**, which sends these emails itself
by default. Nothing changes unless you opt in to sending them through Resend:

1. In Clerk → Webhooks, add `https://<your-site>/api/webhooks/clerk` with the event `email.created`. Put
   its signing secret in `CLERK_WEBHOOK_SIGNING_SECRET`.
2. In Clerk → Emails, turn off **Delivered by Clerk** for the templates you want TikoSoko to send.

Clerk still renders the email. TikoSoko delivers it through Resend, deduplicated per Clerk email id,
with 3 quick attempts because codes expire. The content lives only in the job's `secret` field, which is
deleted when the job finishes. The stored subject is a placeholder, since Clerk subjects can contain the
code.

## Setup

### 1. API key
At resend.com → **API Keys**, create a key:
- **Sending access** is enough to send.
- **Full access** also lets the admin *Check sender domain* button read the domain status.

Put the key in `RESEND_API_KEY`, on the server only. It is read inside `src/server/email/resend.ts`
and is never sent to the browser. Don't commit it.

### 2. Verify a sending domain
At resend.com → **Domains** → *Add domain*, use a subdomain such as `mail.yourdomain.co.ke` or your
main domain. Add the DNS records Resend shows you to your DNS provider:
- SPF (TXT, or MX + TXT on the `send` subdomain)
- DKIM (TXT `resend._domainkey`)
- DMARC (recommended: `_dmarc` TXT `v=DMARC1; p=none;`)

Wait for **Verified**, then set `RESEND_FROM_EMAIL=tickets@yourdomain.co.ke` and
`RESEND_FROM_NAME="Your Brand"`.

**Testing before you have a domain:** use `RESEND_FROM_EMAIL=onboarding@resend.dev`. Resend only
delivers it **to the email address of your own Resend account**. Any other recipient is rejected with a
403 `validation_error`, which shows up as a `rejected` failure in `/admin/operations`. The admin page
warns while the test sender is in use. Don't take real bookings in this mode.

### 3. Webhook
At resend.com → **Webhooks** → *Add endpoint*, use `https://<your-site>/api/webhooks/resend` and select
the events listed above. Copy the signing secret (`whsec_…`) into `RESEND_WEBHOOK_SECRET`. Without a
webhook the last status you'll see is `accepted`. Admins can press *Refresh status*, which calls
`GET /emails/{id}`.

### 4. Switch the transport
```
EMAIL_TRANSPORT=resend
APP_BASE_URL=https://tickets.yourdomain.co.ke   # links in emails
SUPPORT_EMAIL=support@yourdomain.co.ke
```
Restart the app and run the worker (`npm run worker`, or `JOBS_INLINE_WORKER=true` in dev). Then check
`/admin/operations`: the header shows `Email: resend from <address>`, and any configuration problem
appears as a red banner.

## Testing

- **Automated:** `npm test` runs `tests/email.test.ts`, 28 tests against a **fake Resend API** (a
  `fetch` stub). Covered: success with a PDF, multiple tickets, the size fallback, missing recipient,
  missing configuration, invalid key, rejection, 429, timeout, lost response and retry, duplicate
  prevention, payment success with failed email, delayed and duplicate callbacks, bounce, complaint,
  invalid and stale signatures, duplicate webhooks, out-of-order events, link security, Clerk account
  emails, reminders, event updates and payment-failed emails. The tests force the simulated providers
  regardless of your `.env`. These tests prove the code paths; they do not prove delivery by Resend.
- **Real Resend, locally:**
  1. Set `EMAIL_TRANSPORT=resend`, your key, and `RESEND_FROM_EMAIL=onboarding@resend.dev`.
  2. Book a ticket using **your Resend account's email** as the buyer email.
  3. The email should arrive with the PDF, and `/admin/operations` should show `Accepted` and a
     Resend email id.
  4. For webhooks, expose the dev server (e.g. `cloudflared tunnel --url http://localhost:3000`) and
     register `<tunnel>/api/webhooks/resend`. The status then moves to `Delivered`.

## Operations (`/admin/operations`)

- **Email problems:** failed, bounced, complained, suppressed or retrying emails, with the error
  category and Resend id. The actions are:
  - **Retry:** same delivery and same idempotency key, so it can't produce a duplicate.
  - **Send again:** a new email, optionally to a corrected address. For a booking email this also updates
    the booking's contact email, and the change is audited.
  - **Refresh status:** asks Resend for the latest state.
- **Retry config failures:** after fixing the key or sender.
- **Check sender domain:** shows the domain's verification state in Resend.
- **Suppression list:** **Allow again** lifts an entry.
- Retries never re-charge a customer or re-issue tickets. They re-render from the stored records.

## Privacy

- **What's stored:** delivery rows keep the recipient, kind, status, error category and provider id. No
  bodies, no attachments, no one-time codes.
- **Emails stay minimal:** no payment credentials and no ticket codes in the body. Codes are in the PDF
  only. M-Pesa phone numbers never appear.
- **Organizers' sale emails** contain the booking reference, ticket count and total, but not the buyer's
  contact details.
- **Logs:** they never contain the API key or webhook secret.
- **Kenya Data Protection Act 2019:** transactional email is part of providing the service the
  customer paid for. Keep your privacy notice listing Resend (US) as a processor and covering
  cross-border transfer.

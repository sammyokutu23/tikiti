# Before going live

This prototype **does not take real payments or send real email** until you configure the
items below.

## Payments (required before accepting money)

- **M-Pesa** is integrated through Safaricom Daraja (M-Pesa Express / STK Push). Going live needs
  a live Paybill or Till, a Daraja Go Live approval, production credentials, and an HTTPS
  callback URL. See [MPESA.md](MPESA.md) for the full checklist. Live charging stays off until
  `DARAJA_ENV=production` **and** `DARAJA_LIVE_PAYMENTS_ENABLED=true`.
- M-Pesa refunds are **manual**: Express has no refund call, and the Reversal API (initiator
  credentials and a result URL) is not wired in. Refunds show as "Manual reversal" on
  `/admin/operations`. Reverse them in the M-Pesa org portal, then record the reversal ID there.
- **Cards:** still simulated. You need an acquirer or PSP licensed in Kenya and a
  `PaymentProvider` (`src/server/payments/types.ts`) registered in `registry.ts`. When
  `DARAJA_ENV=production`, the card simulator is disabled automatically unless `CARD_PROVIDER` is set.
- Record provider fees as `adjustment` ledger entries.
- Settlement and payouts to organizers are **not implemented**. They need provider support
  (split payments or B2C), KYC for organizers, and a payout ledger. Never pay unverified or
  suspended organizers.
- Don't run the mock provider (`/pay/mock`) in production: set `MPESA_PROVIDER=daraja` and
  `CARD_PROVIDER` to a real provider or `disabled`.
- Run `npm run worker` as a separate process (`JOBS_INLINE_WORKER=false`). It also reconciles
  M-Pesa payments whose callbacks are missing.

## Email

- Use Resend: `EMAIL_TRANSPORT=resend`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL` on a **verified** domain
  (SPF/DKIM/DMARC), `RESEND_WEBHOOK_SECRET` for delivery/bounce events, and `APP_BASE_URL` set to the
  public https address. See [EMAIL.md](EMAIL.md). `smtp` remains available for other providers.
- Don't treat production email as working until the domain shows *Verified* in Resend and a real
  booking email has been received.
- `dev-capture` must not be used in production. `/dev/mail` returns 404 when `NODE_ENV=production`.

## Infrastructure

- **PostgreSQL:** a managed instance with backups and PITR. Run `npm run db:migrate` on deploy;
  migrations in `./drizzle` are additive.
- **Worker:** run `npm run worker` as its own process and set `JOBS_INLINE_WORKER=false` on web nodes.
- **Images:** implement an S3 / R2 / GCS `StorageDriver` (`src/server/storage.ts`) and set
  `STORAGE_DRIVER`. The local driver writes to disk, which is ephemeral on most hosts.
- **Rate limiting** is in-memory per process. Move it to Redis or Postgres when running more than
  one instance.
- **Secrets:** generate strong `SESSION_SECRET`, `QR_SIGNING_SECRET` and `ACCESS_LINK_SECRET`
  values. Rotating `QR_SIGNING_SECRET` invalidates printed QR codes, though manual code entry
  still works.
- Serve over HTTPS (secure cookies; browsers only allow camera access for the scanner on HTTPS).
- Add a CSP, error monitoring (Sentry or similar) and uptime checks.

## Maps

- Replace the public OSM tile server and the public Nominatim instance before real traffic.
  See [MAPS.md](MAPS.md) for the limits and alternatives. Set `GEOCODER_CONTACT_EMAIL` to a
  monitored address.

## Compliance

- Kenya Data Protection Act 2019: register as a data controller/processor with the ODPC, publish a
  privacy policy, and set retention for buyer PII. Attendee CSV exports are audit-logged.
- Terms of service, an organizer agreement and a refund policy framework.
- KRA: VAT on the platform commission and eTIMS invoicing for commission.

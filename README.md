# TikoSoko — event ticketing for Kenya (prototype)

A mobile-first event ticketing marketplace. Customers discover events and buy tickets (guest
checkout, KES). They get one QR-coded ticket per admission, as a PDF and by email. Organizers
create and publish events, track sales and commission, and scan guests in from a phone.
Admins verify organizers, moderate events, inspect transactions and configure commission.
Buyers can also pay in installments with **Lipa Mdogo Mdogo** ([docs/INSTALLMENTS.md](docs/INSTALLMENTS.md)),
and organizers can design event covers in the **AI Banner Studio** ([docs/AI_BANNERS.md](docs/AI_BANNERS.md)).

> **Prototype:** payments are **simulated** by default (a mock provider with signed callbacks).
> **M-Pesa via Safaricom Daraja (STK Push)** is integrated and can be switched on with
> `MPESA_PROVIDER=daraja` and sandbox credentials. See [docs/MPESA.md](docs/MPESA.md). Live
> charging needs an explicit production switch. No card details are collected. Emails are **captured locally** until
> Resend (or SMTP) is configured. See [docs/EMAIL.md](docs/EMAIL.md) and [docs/PRODUCTION.md](docs/PRODUCTION.md).

## Quick start

Requires Node.js ≥ 20.9. PostgreSQL is optional: a local server is bundled via `embedded-postgres`.

```bash
npm install
cp .env.example .env                          # then fill in the four secrets: openssl rand -base64 48
npm run db:start                              # terminal 1: local PostgreSQL on :5433 (leave running)
npm run db:migrate                            # create the schema
npm run db:seed                               # demo data (refuses to run on a non-empty DB)
npm run dev                                   # terminal 2: http://localhost:3000
```

### Signing in (Clerk)

Authentication is handled by [Clerk](https://clerk.com) (development instance; keys in `.env`).
Click **Sign up** in the header to create your account. Your local user, with its role,
bookings and organizer data, is created or linked on first sign-in. Roles are owned by this
app, never by Clerk:

```bash
npm run user:role -- you@example.com admin                       # make yourself an admin
npm run user:link-demo -- you@example.com organizer@tikiti.test  # act as a seeded demo organizer (dev)
```

Seeded demo data belongs to the local users `admin@`, `organizer@`, `organizer2@`, `pending@` and
`customer@tikiti.test`. Guest checkout and guest booking links still work without an account.

Useful pages: `/dev/mail` (captured emails and PDF attachments), `/admin/operations` (jobs,
emails, webhooks), `/organizer/events/<id>/scan` (camera check-in; camera needs HTTPS or localhost).

To reset demo data: `npm run db:seed -- --reset` (dev only; truncates all tables).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run db:start` | Local PostgreSQL (real binaries, data in `.data/postgres`) |
| `npm run db:generate` / `db:migrate` | Drizzle migrations (`./drizzle`) |
| `npm run db:seed` | Seed realistic Kenyan events through the real checkout/payment flow |
| `npm run worker` | Standalone outbox worker (production) |
| `npm test` | Vitest: unit and DB integration tests (uses `TEST_DATABASE_URL`) |
| `npm run e2e` | Browser E2E with Playwright + local Chrome (server running on a seeded DB; the location suite calls real OSM services) |
| `npm run check` | typecheck + lint + tests |
| `npm run user:role` / `user:link-demo` | Manage local roles / link your Clerk login to a demo account |

## Environment

See [.env.example](.env.example). The required secrets are `SESSION_SECRET`,
`QR_SIGNING_SECRET`, `ACCESS_LINK_SECRET` and `MOCK_PAYMENT_WEBHOOK_SECRET`. Email uses
`EMAIL_TRANSPORT` (`dev-capture` | `resend` | `smtp` | `disabled`), the `RESEND_*` settings
([docs/EMAIL.md](docs/EMAIL.md)), `SMTP_URL`, `EMAIL_FROM` and `SUPPORT_EMAIL`. Also:
`PAYMENT_PROVIDER`, `STORAGE_DRIVER`, `JOBS_INLINE_WORKER` and `APP_BASE_URL`. AI banners use
`OPENAI_API_KEY`, `OPENAI_IMAGE_MODEL` and `OPENAI_IMAGE_QUALITY` ([docs/AI_BANNERS.md](docs/AI_BANNERS.md)).

## Docs

- [Architecture & security model](docs/ARCHITECTURE.md)
- [Commission & ledger rules](docs/COMMISSION.md)
- [Reserved seating boundary](docs/RESERVED_SEATING.md)
- [Event maps & venue location](docs/MAPS.md)
- [M-Pesa (Daraja) payments: setup, sandbox, go-live, reconciliation](docs/MPESA.md)
- [Lipa Mdogo Mdogo installment plans](docs/INSTALLMENTS.md)
- [AI Banner Studio (OpenAI)](docs/AI_BANNERS.md)
- [Production checklist](docs/PRODUCTION.md)
- Design reference: [docs/design-reference.png](docs/design-reference.png)

## Design

The UI follows the supplied Dribbble reference: a near-black canvas with soft charcoal
gradients, white pill primary buttons, frosted date badges on large image-first cards, pill
category chips, round icon buttons, a floating pill navigation on phones, and a sticky
"Buy tickets" bar on event pages. Tokens live in `src/app/globals.css`; components live in
`src/components/ui`.

# Lipa Mdogo Mdogo (installment plans)

Customers can reserve tickets with a deposit and pay the rest in M-Pesa installments. It is a
**layaway plan, not a loan**: there's no interest, no late fee and no credit check. Entry tickets
(with QR codes) are issued only once the full balance is verified.

Code: `src/server/plans/` (`policy.ts` for the maths, `apply.ts` for payment application and expiry,
`service.ts` for operations and views). M-Pesa requests go through the existing Daraja adapter
(`payments/mpesa.ts`). Tickets come from the existing `confirmBooking`.

## Who can use it

A plan is offered on the payment page when **all** of these hold:

- the organizer ticked **Offer installment payment plans** on the event (off by default);
- payment plans are enabled in **Admin → Payment plans**;
- M-Pesa is available;
- the event starts at least **7 days** away;
- the order total is at least **KES 500** and in whole shillings;
- the schedule is possible: payments at least a day apart and each at least KES 100.

## Default policy

Admins change it in **Admin → Payment plans**.

| Setting | Default |
|---|---|
| Deposit | 30 % of the order total, rounded **up** to the shilling |
| Installments after the deposit | customer chooses 1, 2 or 3 |
| Final deadline | 48 h before the event starts |
| Earliest plan | 7 days before the event |
| Overdue grace | 72 h past an installment's due date, never past the final deadline |
| Reminder | 3 days before each due date |
| Cancellation fee | 0 % (everything paid is refunded) |

**Policy changes apply only to new plans.** Each plan stores the policy snapshot the customer
accepted, along with the terms version (`PLAN_TERMS_VERSION`) and the acceptance time. Amounts and
due dates are written when the plan is created, so later ticket-price, commission or policy changes
never alter an agreed schedule.

## How the schedule is calculated

All amounts are integer minor units, and every part is a whole shilling (an M-Pesa requirement).

- **Deposit:** `ceil(total × deposit%)`, so it is never below the required percentage.
- **Installments:** the remainder is split evenly, and the **last installment absorbs the rounding**.
  For example, KES 3,000 → 900 + 700 + 700 + 700, and KES 1,000 → 300 + 233 + 233 + 234.
- **Due dates:** spread evenly between now and the final deadline. The last installment is due exactly
  at the deadline.

The schedule covers the whole booking (all ticket lines). The booking items stay unchanged, so each
ticket keeps its own type and reference.

## State model

The three kinds of state are tracked separately:

- `payment_transactions.status`: one M-Pesa attempt.
- `plan_installments.status`: one schedule line. Values: `scheduled → due → payment_pending → paid`,
  plus `failed`, `overdue` and `cancelled`.
- `payment_plans.status`: the plan as a whole.

```
awaiting_deposit ──deposit verified──▶ active ──balance verified──▶ fully_paid  (tickets issued)
awaiting_deposit ──checkout hold lapsed / cancelled──▶ expired / cancelled  (nothing was paid)
active ──missed installment / deadline / customer or admin cancel / event cancelled──▶
       refund_pending ──refunds settled──▶ refunded     (cancelled / expired when nothing to refund)
ended plan ──payment verified afterwards──▶ reconciliation_required ──admin──▶ reinstated | refunded
```

Booking status during a plan: `pending` until the deposit is verified, then `on_plan` (payment
status `partially_paid`), then `confirmed`.

## Payments (Daraja)

Every installment gets its own payment attempt, internal idempotency key and STK Push for exactly
that installment's amount. `payment_transactions.installment_id` links each attempt to its
installment.

- **Paid only on verified evidence.** An installment is marked paid only by a verified callback
  (plus the status-query check), a status query, or an admin decision recorded with a receipt
  number. An accepted STK request or a customer returning to the site never counts.
- **No duplicate charges.** At most one in-flight M-Pesa request per booking (a database
  constraint). While any attempt is `created`, `pending` or `reconciliation_required`, the customer
  can't start another, and the plan can't expire.
- **Applied exactly once.** Row locks on the payment, booking, plan and installment, plus
  forward-only states and a unique `plan_installments.payment_transaction_id`, mean duplicate or
  replayed callbacks change nothing.
- **Duplicate payment for an installment that's already paid:** the second payment is refunded.
- **Amount mismatch or reused receipt:** flagged for reconciliation, never applied (the existing
  checks).
- **Customers can't overpay.** Each request is the next installment's exact amount, and the server
  checks it against the outstanding balance.

## Inventory

- **Held during the plan.** Tickets stay on `ticket_types.reserved` (the same atomic hold as normal
  checkout) until the plan is fully paid, then move to `sold`.
- **Bounded.** The hold lasts until the final deadline (48 h before the event) at most. It ends
  earlier on cancellation or a missed installment, because unpaid plans can't hold scarce tickets
  indefinitely.
- **Late deposit.** If the deposit is verified after the 10-minute checkout hold lapsed, the tickets
  are re-held when still available and the plan continues. Otherwise the payment is flagged for
  reconciliation.
- **Payment after the plan ended.** The plan becomes `reconciliation_required`. No tickets are
  issued and no money is silently kept. An admin either **reinstates** the plan (which needs the
  tickets to still be available) or **refunds** the payment.

## Missed payments, cancellation and refunds

- **Overdue installment:** the customer gets an overdue email. If it's still unpaid after the grace
  period, or the final deadline passes, the plan ends.
- **Customer cancellation:** from the booking page, at any time before the plan is fully paid.
- **What happens when a plan ends:** the tickets are released, unpaid installments are cancelled,
  and **everything paid is refunded** minus the cancellation fee. The fee is 0 by default and is
  always 0 for event or admin cancellations.
  - Refunds are recorded per payment in `refunds` and processed by the existing refund job.
  - M-Pesa refunds become `manual_required`: reverse them in the M-Pesa org portal, then record them
    in **Admin → Operations**.
  - Customers are told a refund was **started**. They get a second email only when it's completed.
- **After full payment:** the event's normal refund policy applies (`refundBooking`). A plan-paid
  booking is refunded per payment.
- **Event cancelled:** active plans are refunded in full.

## Emails (Resend)

Every email is deduplicated, delivered through the existing outbox and retried safely. An email
failure never changes a payment or plan.

| Kind | When |
|---|---|
| `plan_deposit_confirmed` | Deposit verified. This also confirms the plan was created, because a plan only takes effect with its deposit. |
| `plan_payment_confirmed` | Each later installment verified |
| `plan_installment_due` | Installment due within the reminder window (once per installment) |
| `plan_installment_overdue` | Installment overdue (once per installment) |
| `plan_final_deadline` | 48 h before the final deadline with a balance left (once per plan) |
| `plan_payment_failed` | M-Pesa reported a failed or cancelled installment |
| `plan_ended` | Plan cancelled or expired, with the refund amount |
| `plan_payment_review` | A payment arrived after the plan ended |
| `booking_confirmation` | Fully paid: PDF tickets, with a "plan complete" note |
| `refund_completed` | Each refund confirmed |

Dates are shown in the event's time zone. Reminders and expiry run from the worker tick (every
minute; `/api/cron/tick` on Vercel).

## Dashboards

- **Customer** (booking page):
  - the totals, paid amount, balance and a progress bar;
  - the schedule, with statuses;
  - the next payment and a **Pay** button;
  - the payment history and the cancel option;
  - live status at `/bookings/<ref>/plan/status`.
- **Organizer** (**Payment plans**): active plans, collected and outstanding amounts, upcoming
  deadlines, fully-paid and ended plans. Only for the organizer's own events, and without buyer
  contact details.
- **Admin** (**Payment plans**):
  - the policy;
  - tabs for needs attention, active and all plans;
  - per-plan detail: schedule, every payment attempt, refunds, cancel & refund, and late-payment
    resolution.

  Every manual change is audited.

## Testing

`npm test` runs `tests/installments.test.ts` (24 tests) with the **simulated** provider. Covered:

- **Schedule maths:** splitting and rounding, the final-deadline schedule and ineligible events.
- **Plan setup:** opting in, accepting terms, and schedules surviving price and policy changes.
- **Deposit:** a verified deposit holds the tickets without issuing them, and an accepted STK request
  alone never counts as paid.
- **Payment safety:** duplicate callbacks, an in-flight resubmit, a failed then retried installment,
  and email failures.
- **Completing a plan:** full payment issues tickets and the PDF email once, and inventory can't be
  oversold.
- **Reminders and expiry:** reminders and overdue notices, expiry with refunds, no expiry while a
  payment is in flight, and a late deposit being reinstated.
- **Late payments, cancellations and access:** a late payment after expiry is flagged and then
  refunded by an admin, customer cancellation with a fee, event cancellation, and organizer data
  isolation.

These tests don't prove real M-Pesa behaviour. For a sandbox run, set
`MPESA_PROVIDER=daraja` (see [MPESA.md](MPESA.md)):

1. Enable the plan option on a published event at least 8 days away.
2. Choose Lipa Mdogo Mdogo at checkout.
3. Approve the deposit prompt on the sandbox test phone, and confirm the plan becomes active with no
   tickets yet.
4. Pay the remaining installments from the booking page, and confirm tickets and the PDF email
   arrive.

To exercise expiry without waiting, move an installment's `due_at` into the past in a dev database
and let the worker run.

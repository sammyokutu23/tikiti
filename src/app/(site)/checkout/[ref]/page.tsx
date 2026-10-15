import { and, eq, inArray } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { Clock, ShieldAlert } from "lucide-react";
import { db } from "@/db";
import { bookingItems, events, paymentTransactions } from "@/db/schema";
import { Countdown, PaymentForm } from "@/app/(site)/checkout/forms";
import { cancelCheckoutAction } from "@/app/(site)/checkout/actions";
import { OrderSummary } from "@/components/events/order-summary";
import { Alert, ButtonLink, Card, EmptyState } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { randomToken } from "@/lib/crypto";
import { formatPhone } from "@/lib/utils";
import { authorizeBooking } from "@/server/bookings/authorize";
import { expireStaleBookings } from "@/server/bookings/lifecycle";
import { checkoutPaymentModes } from "@/server/payments/options";
import { formatDateTime } from "@/lib/dates";
import { loadPlan, planOfferForBooking } from "@/server/plans/service";
import { PaymentChoice, PlanCheckoutForm } from "@/app/(site)/bookings/plan-forms";

export const metadata = { title: "Payment" };

export default async function PaymentPage({ params, searchParams }: PageProps<"/checkout/[ref]">) {
  const { ref } = await params;
  const { access: q } = await searchParams;
  await expireStaleBookings();
  const access = await authorizeBooking(ref, typeof q === "string" ? q : null);
  if (!access) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <EmptyState icon={<ShieldAlert className="size-6" />} title="We can't open this checkout" body="Use the same browser you started checkout in, or the link from your email." action={<ButtonLink href="/bookings/find">Find my booking</ButtonLink>} />
      </div>
    );
  }
  const { booking, token } = access;
  if (booking.status === "confirmed" || booking.status === "refunded" || booking.status === "failed") {
    redirect(`/bookings/${ref}${token ? `?access=${token}` : ""}`);
  }
  const [event] = await db.select().from(events).where(eq(events.id, booking.eventId));
  if (!event) notFound();
  const items = await db.select().from(bookingItems).where(eq(bookingItems.bookingId, booking.id));
  const [inFlight] = await db
    .select({ id: paymentTransactions.id })
    .from(paymentTransactions)
    .where(and(eq(paymentTransactions.bookingId, booking.id), eq(paymentTransactions.provider, "daraja"), inArray(paymentTransactions.status, ["created", "pending"])));
  const statusHref = `/checkout/${ref}/status${token ? `?access=${token}` : ""}`;
  // A plan whose deposit request was already sent is managed from the booking page.
  const existingPlan = await loadPlan(booking.id);
  if (existingPlan && existingPlan.plan.status !== "awaiting_deposit") redirect(`/bookings/${ref}${token ? `?access=${token}` : ""}`);
  const offer = booking.status === "pending" ? await planOfferForBooking(booking, event) : null;

  const summary = (
    <OrderSummary
      event={event}
      lines={items.map((i) => ({ name: i.ticketTypeName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor }))}
      subtotalMinor={booking.subtotalMinor}
      feesMinor={booking.feesMinor}
      discountMinor={booking.discountMinor}
      totalMinor={booking.totalMinor}
      footer={<p className="text-xs text-muted">Booking reference <span className="font-mono text-fg">{booking.reference}</span></p>}
    />
  );

  if (booking.status !== "pending") {
    return (
      <div className="mx-auto max-w-lg space-y-6 px-4 py-12">
        <Alert tone="warning" title={booking.status === "expired" ? "Your reservation expired" : "This order was cancelled"}>
          The tickets have been released. If you were charged, you&apos;ll be refunded automatically or your booking will be confirmed if tickets are still available.
        </Alert>
        {summary}
        <ButtonLink href={`/events/${event.slug}`} full>Start a new order</ButtonLink>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-5 sm:px-6 sm:pt-10">
      <div className="mb-6">
        <p className="text-xs text-muted">Step 2 of 2</p>
        <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Payment</h1>
      </div>
      <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card className="flex items-center gap-3 p-4">
            <Clock className="size-5 text-muted" aria-hidden />
            <p className="text-sm">
              Tickets reserved for <strong><Countdown expiresAt={booking.expiresAt.toISOString()} /></strong>. Complete payment before the timer runs out.
            </p>
          </Card>
          {inFlight && (
            <Alert tone="info" title="An M-Pesa prompt is already on its way">
              Check your phone and enter your PIN there. <a href={statusHref} className="underline">See payment status</a> — don&apos;t pay twice.
            </Alert>
          )}
          {(() => {
            const full = (
              <PaymentForm
                reference={booking.reference}
                access={token}
                idempotencyKey={`pay_${randomToken(18)}`}
                phone={formatPhone(booking.buyerPhone)}
                totalMinor={booking.totalMinor}
                failed={booking.paymentStatus === "failed"}
                modes={checkoutPaymentModes()}
              />
            );
            if (!offer?.available) return full;
            return (
              <PaymentChoice
                full={full}
                plan={
                  <PlanCheckoutForm
                    reference={booking.reference}
                    access={token}
                    idempotencyKey={`plan_${randomToken(18)}`}
                    phone={formatPhone(booking.buyerPhone)}
                    totalMinor={booking.totalMinor}
                    refundPolicy={event.refundPolicy}
                    terms={offer.terms}
                    options={offer.options.map((o) => ({
                      installmentCount: o.installmentCount,
                      depositMinor: o.depositMinor,
                      finalDueLabel: formatDateTime(o.finalDueAt, event.timezone),
                      lines: o.lines.map((l) => ({ sequence: l.sequence, amountMinor: l.amountMinor, dueLabel: formatDateTime(l.dueAt, event.timezone) })),
                    }))}
                  />
                }
              />
            );
          })()}
          <form action={cancelCheckoutAction} className="text-center">
            <input type="hidden" name="reference" value={booking.reference} />
            <input type="hidden" name="access" value={token ?? ""} />
            <SubmitButton variant="ghost" size="sm">Cancel order and release tickets</SubmitButton>
          </form>
        </div>
        <div>{summary}</div>
      </div>
    </div>
  );
}

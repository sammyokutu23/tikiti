import { and, eq } from "drizzle-orm";
import { FlaskConical, Smartphone, CreditCard } from "lucide-react";
import { db } from "@/db";
import { bookings, events, paymentTransactions } from "@/db/schema";
import { EmptyState } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { authorizeBooking } from "@/server/bookings/authorize";
import { simulateMockPayment } from "../actions";

export const metadata = { title: "Simulated payment" };

export default async function MockPayPage({ params, searchParams }: PageProps<"/pay/mock/[providerRef]">) {
  const { providerRef } = await params;
  const { access: q } = await searchParams;
  const [row] = await db
    .select({ payment: paymentTransactions, booking: bookings, eventTitle: events.title })
    .from(paymentTransactions)
    .innerJoin(bookings, eq(bookings.id, paymentTransactions.bookingId))
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(and(eq(paymentTransactions.provider, "mock"), eq(paymentTransactions.providerReference, providerRef)));
  const access = row ? await authorizeBooking(row.booking.reference, typeof q === "string" ? q : null) : null;

  if (!row || !access) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <EmptyState title="Payment session not found" body="This payment link is invalid or belongs to another browser session." />
      </main>
    );
  }
  const { payment } = row;
  const done = payment.status !== "pending" && payment.status !== "created";

  return (
    <main className="mx-auto w-full max-w-md px-4 pb-16 pt-8">
      <div className="mb-5 flex items-center gap-2 rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
        <FlaskConical className="size-4 shrink-0" aria-hidden />
        <span><strong>Test mode.</strong> This page simulates a payment provider. No money moves.</span>
      </div>
      <div className="overflow-hidden rounded-[2rem] border border-line bg-surface">
        <div className="space-y-1 border-b border-line p-6 text-center">
          <p className="text-xs uppercase tracking-widest text-muted">Mock Payments · Merchant: TikoSoko</p>
          <p className="text-4xl font-bold tabular-nums">{formatMoney(payment.amountMinor, payment.currency)}</p>
          <p className="text-sm text-muted">{row.eventTitle} · {row.booking.reference}</p>
        </div>
        <div className="space-y-4 p-6">
          <div className="flex items-center gap-3 rounded-2xl bg-fg/5 p-4">
            {payment.method === "mpesa" ? <Smartphone className="size-6" aria-hidden /> : <CreditCard className="size-6" aria-hidden />}
            <div className="text-sm">
              {payment.method === "mpesa" ? (
                <>
                  <p className="font-semibold">M-Pesa STK push sent</p>
                  <p className="text-muted">to {formatPhone(payment.payerPhone ?? "")}. In real life you&apos;d enter your PIN on your phone.</p>
                </>
              ) : (
                <>
                  <p className="font-semibold">Card payment</p>
                  <p className="text-muted">A real provider would show its secure card form here. We never collect card details.</p>
                </>
              )}
            </div>
          </div>
          {done ? (
            <p className="text-center text-sm text-muted">This payment is already {payment.status}.</p>
          ) : (
            <div className="space-y-2.5">
              <p className="text-xs font-medium text-muted">Choose what the provider reports back:</p>
              <MockButton providerRef={providerRef} access={access.token} outcome="succeeded" variant="primary">Approve payment</MockButton>
              <MockButton providerRef={providerRef} access={access.token} outcome="succeeded" delay={20}>Approve — callback delayed 20s</MockButton>
              <MockButton providerRef={providerRef} access={access.token} outcome="failed" variant="danger">Decline ({payment.method === "mpesa" ? "insufficient funds" : "card declined"})</MockButton>
              <MockButton providerRef={providerRef} access={access.token} outcome="cancelled" variant="ghost">Customer cancels</MockButton>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function MockButton({
  providerRef,
  access,
  outcome,
  delay = 0,
  children,
  variant = "secondary",
}: {
  providerRef: string;
  access: string | null;
  outcome: string;
  delay?: number;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <form action={simulateMockPayment}>
      <input type="hidden" name="providerRef" value={providerRef} />
      <input type="hidden" name="outcome" value={outcome} />
      <input type="hidden" name="delay" value={delay} />
      <input type="hidden" name="access" value={access ?? ""} />
      <SubmitButton full size="lg" variant={variant}>{children}</SubmitButton>
    </form>
  );
}

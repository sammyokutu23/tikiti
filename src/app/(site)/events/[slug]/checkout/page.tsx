import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { BuyerForm } from "@/app/(site)/checkout/forms";
import { OrderSummary } from "@/components/events/order-summary";
import { Alert, ButtonLink, IconLink } from "@/components/ui";
import { randomToken } from "@/lib/crypto";
import { formatPhone } from "@/lib/utils";
import { getCurrentUser } from "@/server/auth/session";
import { MAX_TICKETS_PER_BOOKING } from "@/server/bookings/checkout";
import { getPublicEvent } from "@/server/events/queries";

export const metadata = { title: "Checkout" };

export default async function CheckoutPage({ params, searchParams }: PageProps<"/events/[slug]/checkout">) {
  const { slug } = await params;
  const { t } = await searchParams;
  const detail = await getPublicEvent(slug);
  if (!detail) notFound();
  const { event } = detail;

  const selection = new Map<string, number>();
  for (const part of String(t ?? "").split(",").slice(0, 20)) {
    const [id, q] = part.split(":");
    const n = Number(q);
    if (id && Number.isInteger(n) && n > 0 && n <= 50) selection.set(id, n);
  }
  const lines = detail.ticketTypes
    .filter((tt) => selection.has(tt.id))
    .map((tt) => ({ tt, quantity: selection.get(tt.id)! }));

  const problems: string[] = [];
  if (event.status !== "published") problems.push("This event is not on sale.");
  for (const { tt, quantity } of lines) {
    if (tt.saleState !== "on_sale") problems.push(`${tt.name} is no longer on sale.`);
    else if (quantity > tt.remaining) problems.push(`Only ${tt.remaining} ${tt.name} ticket${tt.remaining === 1 ? "" : "s"} left.`);
    else if (quantity > tt.maxPerOrder) problems.push(`Maximum ${tt.maxPerOrder} ${tt.name} tickets per order.`);
  }
  const totalQty = lines.reduce((s, l) => s + l.quantity, 0);
  if (totalQty > MAX_TICKETS_PER_BOOKING) problems.push(`You can book up to ${MAX_TICKETS_PER_BOOKING} tickets per order.`);
  if (lines.length === 0) problems.push("You haven't selected any tickets.");

  const subtotal = lines.reduce((s, l) => s + l.tt.priceMinor * l.quantity, 0);
  const user = await getCurrentUser();

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-5 sm:px-6 sm:pt-10">
      <div className="mb-6 flex items-center gap-3">
        <IconLink href={`/events/${slug}`} label="Back to event"><ArrowLeft className="size-5" aria-hidden /></IconLink>
        <div>
          <p className="text-xs text-muted">Step 1 of 2</p>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Your details</h1>
        </div>
      </div>

      {problems.length > 0 ? (
        <div className="max-w-xl space-y-4">
          <Alert tone="danger" title="We can't continue with this order">
            <ul className="list-inside list-disc">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </Alert>
          <ButtonLink href={`/events/${slug}`} variant="secondary">Choose tickets again</ButtonLink>
        </div>
      ) : (
        <div className="grid gap-8 lg:grid-cols-[1fr_380px]">
          <div className="order-2 lg:order-1">
            {!user && (
              <p className="mb-4 text-sm text-muted">
                Checking out as a guest. <a href={`/sign-in?redirect_url=${encodeURIComponent(`/events/${slug}/checkout?t=${t}`)}`} className="text-fg underline-offset-4 hover:underline">Log in</a> to save tickets to your account.
              </p>
            )}
            <BuyerForm
              eventId={event.id}
              items={lines.map((l) => ({ ticketTypeId: l.tt.id, quantity: l.quantity }))}
              idempotencyKey={`co_${randomToken(18)}`}
              defaults={{ name: user?.name, email: user?.email, phone: user?.phone ? formatPhone(user.phone) : undefined }}
              totalMinor={subtotal}
              refundPolicy={event.refundPolicy}
            />
          </div>
          <div className="order-1 lg:order-2">
            <OrderSummary
              event={event}
              lines={lines.map((l) => ({ name: l.tt.name, quantity: l.quantity, unitPriceMinor: l.tt.priceMinor }))}
              subtotalMinor={subtotal}
              totalMinor={subtotal}
            />
          </div>
        </div>
      )}
    </div>
  );
}

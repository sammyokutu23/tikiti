"use client";

import { useActionState, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Alert, Field, Input, Textarea } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { formatMoney } from "@/lib/money";
import { createExternalListingAction, createPlatformListingAction, createResaleCheckoutAction } from "./actions";

/** Mirrors server/resale/policy.ts so sellers see what buyers will pay. */
const feeKes = (priceKes: number) => Math.ceil(priceKes * 0.1);

function PriceField({ error, defaultValue }: { error?: string; defaultValue?: string }) {
  const [price, setPrice] = useState(defaultValue ?? "");
  const n = Number(price);
  const valid = Number.isInteger(n) && n > 0;
  return (
    <Field
      label="Your price (KES)"
      htmlFor="priceKes"
      error={error}
      hint={valid ? `You receive KES ${n.toLocaleString("en-KE")}. Buyers pay KES ${(n + feeKes(n)).toLocaleString("en-KE")} including the 10% resale fee.` : "Whole shillings. You receive the full amount; buyers pay a 10% fee on top."}
    >
      <Input id="priceKes" name="priceKes" type="number" inputMode="numeric" min={50} step={1} required value={price} onChange={(e) => setPrice(e.target.value)} error={error} />
    </Field>
  );
}

export function PlatformListingForm({ ticketId, defaultPhone, faceValueMinor }: { ticketId: string; defaultPhone: string; faceValueMinor: number }) {
  const [state, action, pending] = useActionState(createPlatformListingAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-start" noValidate>
      {state.error && <Alert tone="danger" className="sm:col-span-3">{state.error}</Alert>}
      <input type="hidden" name="ticketId" value={ticketId} />
      <PriceField error={fe.priceKes} defaultValue={v.priceKes ?? String(faceValueMinor / 100)} />
      <Field label="M-Pesa number for payout" htmlFor="payoutPhone" error={fe.payoutPhone}>
        <Input id="payoutPhone" name="payoutPhone" type="tel" inputMode="tel" placeholder="0712 345 678" required defaultValue={v.payoutPhone ?? defaultPhone} error={fe.payoutPhone} />
      </Field>
      <SubmitButton pending={pending} pendingLabel="Listing…" className="sm:mt-7">List ticket</SubmitButton>
    </form>
  );
}

export function ExternalListingForm({ defaultPhone }: { defaultPhone: string }) {
  const [state, action, pending] = useActionState(createExternalListingAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-6" noValidate>
      {state.error && <Alert tone="danger" title="We couldn't submit your ticket">{state.error}</Alert>}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-lg font-semibold">The event</legend>
        <Field label="Event name" htmlFor="eventName" error={fe.eventName} className="sm:col-span-2">
          <Input id="eventName" name="eventName" required defaultValue={v.eventName} error={fe.eventName} placeholder="e.g. Blankets & Wine" />
        </Field>
        <Field label="Venue" htmlFor="venue" error={fe.venue}>
          <Input id="venue" name="venue" required defaultValue={v.venue} error={fe.venue} />
        </Field>
        <Field label="City" htmlFor="city" error={fe.city}>
          <Input id="city" name="city" required defaultValue={v.city ?? "Nairobi"} error={fe.city} />
        </Field>
        <Field label="Date and time (Nairobi)" htmlFor="startsAtLocal" error={fe.startsAtLocal}>
          <Input id="startsAtLocal" name="startsAtLocal" type="datetime-local" required defaultValue={v.startsAtLocal} error={fe.startsAtLocal} />
        </Field>
        <Field label="Ticket type" htmlFor="ticketTypeName" error={fe.ticketTypeName}>
          <Input id="ticketTypeName" name="ticketTypeName" required defaultValue={v.ticketTypeName} error={fe.ticketTypeName} placeholder="Regular, VIP…" />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-lg font-semibold">Where you bought it</legend>
        <Field label="Platform" htmlFor="platform" error={fe.platform}>
          <Input id="platform" name="platform" required defaultValue={v.platform} error={fe.platform} placeholder="Mookh, Ticketsasa, the organizer…" />
        </Field>
        <Field label="Order or receipt number" htmlFor="orderRef" error={fe.orderRef} hint="Optional, but it speeds up review.">
          <Input id="orderRef" name="orderRef" defaultValue={v.orderRef} error={fe.orderRef} />
        </Field>
        <Field label="Ticket file" htmlFor="ticketFile" hint="The ticket the buyer will receive: PDF or image, up to 2 MB." className="sm:col-span-1">
          <Input id="ticketFile" name="ticketFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required />
        </Field>
        <Field label="Proof of purchase" htmlFor="proofFile" hint="Receipt, confirmation email or M-Pesa message. Only our team sees it." className="sm:col-span-1">
          <Input id="proofFile" name="proofFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" required />
        </Field>
        <Field label="Anything buyers or our team should know" htmlFor="note" error={fe.note} className="sm:col-span-2">
          <Textarea id="note" name="note" defaultValue={v.note} error={fe.note} placeholder="e.g. Name on the ticket can be changed at the gate" />
        </Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-lg font-semibold">Price and payout</legend>
        <PriceField error={fe.priceKes} defaultValue={v.priceKes} />
        <Field label="M-Pesa number for payout" htmlFor="payoutPhone" error={fe.payoutPhone}>
          <Input id="payoutPhone" name="payoutPhone" type="tel" inputMode="tel" placeholder="0712 345 678" required defaultValue={v.payoutPhone ?? defaultPhone} error={fe.payoutPhone} />
        </Field>
      </fieldset>

      <div className="space-y-1">
        <label className="flex items-start gap-3 text-sm text-fg/80">
          <input type="checkbox" name="confirm" className="mt-0.5 size-5 shrink-0 accent-teal" aria-invalid={fe.confirm ? true : undefined} />
          <span>This ticket is mine, it hasn&apos;t been used or sold elsewhere, and I won&apos;t use or share it after it sells. I understand I&apos;m paid after the event, and not at all if the buyer can&apos;t get in.</span>
        </label>
        {fe.confirm && <p className="text-xs text-danger">{fe.confirm}</p>}
      </div>
      <SubmitButton size="lg" pending={pending} pendingLabel="Uploading…">Submit for review</SubmitButton>
    </form>
  );
}

export function ResaleBuyForm({
  listingId,
  idempotencyKey,
  totalMinor,
  defaults,
  external,
}: {
  listingId: string;
  idempotencyKey: string;
  totalMinor: number;
  defaults: { name?: string; email?: string; phone?: string };
  external: boolean;
}) {
  const [state, action, pending] = useActionState(createResaleCheckoutAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger" title="We couldn't reserve this ticket">{state.error}</Alert>}
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field label="Full name" htmlFor="buyerName" error={fe.buyerName} hint={external ? undefined : "Printed on your new ticket."}>
        <Input id="buyerName" name="buyerName" autoComplete="name" required defaultValue={v.buyerName ?? defaults.name} error={fe.buyerName} />
      </Field>
      <Field label="Email address" htmlFor="buyerEmail" error={fe.buyerEmail} hint="We'll send your ticket here.">
        <Input id="buyerEmail" name="buyerEmail" type="email" autoComplete="email" inputMode="email" required defaultValue={v.buyerEmail ?? defaults.email} error={fe.buyerEmail} />
      </Field>
      <Field label="Phone number" htmlFor="buyerPhone" error={fe.buyerPhone} hint="For M-Pesa and updates.">
        <Input id="buyerPhone" name="buyerPhone" type="tel" autoComplete="tel" inputMode="tel" placeholder="0712 345 678" required defaultValue={v.buyerPhone ?? defaults.phone} error={fe.buyerPhone} />
      </Field>
      <div className="space-y-1">
        <label className="flex items-start gap-3 text-sm text-fg/80">
          <input type="checkbox" name="terms" className="mt-0.5 size-5 shrink-0 accent-teal" aria-invalid={fe.terms ? true : undefined} />
          <span>
            {external
              ? "I understand this ticket was bought on another platform. If it doesn't work, I'll report it from my booking page before the deadline to get a full refund."
              : "I understand the seller's ticket will be cancelled and I'll get a new TikoSoko ticket with its own QR code."}
          </span>
        </label>
        {fe.terms && <p className="text-xs text-danger">{fe.terms}</p>}
      </div>
      <SubmitButton full size="lg" pending={pending} pendingLabel="Reserving…">Continue to payment · {formatMoney(totalMinor)}</SubmitButton>
      <p className="flex items-center justify-center gap-1.5 text-xs text-subtle">
        {external ? <ShieldCheck className="size-3.5" aria-hidden /> : <Lock className="size-3.5" aria-hidden />}
        Held for you for 10 minutes. The seller is only paid after the event.
      </p>
    </form>
  );
}

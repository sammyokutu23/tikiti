"use client";

import { useActionState, useEffect, useState } from "react";
import { CreditCard, Lock, Smartphone } from "lucide-react";
import { Alert, Field, Input } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { createCheckoutAction, startPaymentAction } from "./actions";

export function BuyerForm({
  eventId,
  items,
  idempotencyKey,
  defaults,
  totalMinor,
  refundPolicy,
}: {
  eventId: string;
  items: { ticketTypeId: string; quantity: number }[];
  idempotencyKey: string;
  defaults: { name?: string; email?: string; phone?: string };
  totalMinor: number;
  refundPolicy: string;
}) {
  const [state, action, pending] = useActionState(createCheckoutAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  const v = state.values ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      {state.error && <Alert tone="danger" title="We couldn't reserve your tickets">{state.error}</Alert>}
      {Object.keys(fe).some((k) => k.startsWith("items")) && <Alert tone="danger">Your ticket selection is no longer valid.</Alert>}
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="items" value={JSON.stringify(items)} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field label="Full name" htmlFor="buyerName" error={fe.buyerName} hint="Printed on your tickets.">
        <Input id="buyerName" name="buyerName" autoComplete="name" required defaultValue={v.buyerName ?? defaults.name} error={fe.buyerName} />
      </Field>
      <Field label="Email address" htmlFor="buyerEmail" error={fe.buyerEmail} hint="We'll send your PDF tickets here.">
        <Input id="buyerEmail" name="buyerEmail" type="email" autoComplete="email" inputMode="email" required defaultValue={v.buyerEmail ?? defaults.email} error={fe.buyerEmail} />
      </Field>
      <Field label="Phone number" htmlFor="buyerPhone" error={fe.buyerPhone} hint="For booking updates and M-Pesa.">
        <Input id="buyerPhone" name="buyerPhone" type="tel" autoComplete="tel" inputMode="tel" placeholder="0712 345 678" required defaultValue={v.buyerPhone ?? defaults.phone} error={fe.buyerPhone} />
      </Field>
      <div className="space-y-1">
        <label className="flex items-start gap-3 text-sm text-fg/80">
          <input type="checkbox" name="terms" className="mt-0.5 size-5 shrink-0 accent-white" aria-invalid={fe.terms ? true : undefined} />
          <span>
            I agree to the event&apos;s refund policy: <span className="text-muted">{refundPolicy.length > 140 ? `${refundPolicy.slice(0, 140)}…` : refundPolicy}</span>
          </span>
        </label>
        {fe.terms && <p className="text-xs text-danger">{fe.terms}</p>}
      </div>
      <SubmitButton full size="lg" pending={pending} pendingLabel="Reserving tickets…">
        {totalMinor === 0 ? "Confirm free booking" : `Continue to payment · ${formatMoney(totalMinor)}`}
      </SubmitButton>
      <p className="flex items-center justify-center gap-1.5 text-xs text-subtle">
        <Lock className="size-3.5" aria-hidden /> No account needed. Tickets are held for 10 minutes while you pay.
      </p>
    </form>
  );
}

type MethodMode = "simulated" | "sandbox" | "live" | "unavailable";

export function PaymentForm({
  reference,
  access,
  idempotencyKey,
  phone,
  totalMinor,
  failed,
  modes,
}: {
  reference: string;
  access: string | null;
  idempotencyKey: string;
  phone: string;
  totalMinor: number;
  failed: boolean;
  modes: { mpesa: MethodMode; card: MethodMode };
}) {
  const [state, action, pending] = useActionState(startPaymentAction, {} as FormState);
  const [method, setMethod] = useState<"mpesa" | "card">(modes.mpesa !== "unavailable" || modes.card === "unavailable" ? "mpesa" : "card");
  const mode = modes[method];
  const nothingAvailable = modes.mpesa === "unavailable" && modes.card === "unavailable";
  const option = (m: "mpesa" | "card") =>
    cn(
      "flex cursor-pointer items-center gap-3 rounded-3xl border p-4 transition has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-fg",
      method === m ? "border-fg/50 bg-fg/[.07]" : "border-line bg-surface/70 hover:border-line-strong",
    );
  return (
    <form action={action} className="space-y-4" noValidate>
      {failed && !state.error && (
        <Alert tone="warning" title="Your last payment didn't go through">Your tickets are still reserved — you can try again.</Alert>
      )}
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="access" value={access ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-medium">Payment method</legend>
        {modes.mpesa !== "unavailable" && (
          <label className={option("mpesa")}>
            <input type="radio" name="method" value="mpesa" checked={method === "mpesa"} onChange={() => setMethod("mpesa")} className="sr-only" />
            <span className="flex size-11 items-center justify-center rounded-2xl bg-[#3bb54a] text-white"><Smartphone className="size-5" aria-hidden /></span>
            <span className="flex-1">
              <span className="block font-semibold">M-Pesa</span>
              <span className="block text-xs text-muted">Get a payment prompt on your phone and enter your PIN there</span>
            </span>
            <Radio checked={method === "mpesa"} />
          </label>
        )}
        {modes.card !== "unavailable" && (
          <label className={option("card")}>
            <input type="radio" name="method" value="card" checked={method === "card"} onChange={() => setMethod("card")} className="sr-only" />
            <span className="flex size-11 items-center justify-center rounded-2xl bg-primary text-primary-fg"><CreditCard className="size-5" aria-hidden /></span>
            <span className="flex-1">
              <span className="block font-semibold">Card</span>
              <span className="block text-xs text-muted">Visa or Mastercard on a secure payment page</span>
            </span>
            <Radio checked={method === "card"} />
          </label>
        )}
        {nothingAvailable && <Alert tone="warning">Online payment is temporarily unavailable. Your tickets stay reserved until the timer runs out.</Alert>}
      </fieldset>
      {method === "mpesa" && modes.mpesa !== "unavailable" && (
        <Field label="M-Pesa phone number" htmlFor="phone" error={state.fieldErrors?.phone} hint="The Safaricom number that will receive the prompt. Check it before paying.">
          <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" defaultValue={state.values?.phone ?? phone} error={state.fieldErrors?.phone} />
        </Field>
      )}
      <SubmitButton full size="lg" pending={pending} disabled={nothingAvailable} pendingLabel={method === "mpesa" ? "Sending M-Pesa prompt…" : "Starting payment…"}>
        {method === "mpesa" ? `Pay with M-Pesa · ${formatMoney(totalMinor)}` : `Pay ${formatMoney(totalMinor)}`}
      </SubmitButton>
      {method === "mpesa" && mode !== "simulated" && (
        <p className="flex items-start justify-center gap-1.5 text-center text-xs text-subtle">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>Enter your PIN only in the official M-Pesa prompt on your phone. Tikiti will never ask for your M-Pesa PIN.</span>
        </p>
      )}
      {mode === "sandbox" && (
        <p className="text-center text-xs text-warning">M-Pesa sandbox: requests go to Safaricom&apos;s test environment. No real money moves.</p>
      )}
      {mode === "simulated" && (
        <p className="text-center text-xs text-subtle">
          Test mode: you&apos;ll be taken to a simulated payment page. No real money moves and no card details are collected.
        </p>
      )}
    </form>
  );
}

function Radio({ checked }: { checked: boolean }) {
  return (
    <span aria-hidden className={cn("flex size-5 items-center justify-center rounded-full border-2", checked ? "border-fg" : "border-fg/30")}>
      {checked && <span className="size-2.5 rounded-full bg-fg" />}
    </span>
  );
}

export function Countdown({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    const end = new Date(expiresAt).getTime();
    const tick = () => setLeft(Math.max(0, Math.floor((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (left === null) return <span className="tabular-nums">--:--</span>;
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");
  return (
    <span className={cn("tabular-nums", left < 60 && "text-warning")} role="timer" aria-live={left < 60 ? "polite" : "off"}>
      {left === 0 ? "expired" : `${mm}:${ss}`}
    </span>
  );
}

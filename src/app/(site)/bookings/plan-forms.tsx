"use client";

import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { AlertTriangle, CalendarClock, CheckCircle2, Loader2, Lock, RotateCcw, Smartphone, XCircle } from "lucide-react";
import { Alert, Field, Input, buttonClasses } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/forms";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import { payInstallmentAction, startPlanAction } from "./plan-actions";

export type PlanOptionView = {
  installmentCount: number;
  depositMinor: number;
  lines: { sequence: number; amountMinor: number; dueLabel: string }[];
  finalDueLabel: string;
};

/** Payment page: "Pay in full" vs "Lipa Mdogo Mdogo". The full-payment form is passed in unchanged. */
export function PaymentChoice({ full, plan }: { full: React.ReactNode; plan: React.ReactNode }) {
  const [mode, setMode] = useState<"full" | "plan">("full");
  const tab = (m: "full" | "plan") =>
    cn("flex-1 rounded-full px-4 py-2.5 text-sm font-semibold transition", mode === m ? "bg-primary text-primary-fg" : "text-fg/75 hover:text-fg");
  return (
    <div className="space-y-5">
      <div className="flex gap-1 rounded-full border border-line bg-surface/70 p-1" role="tablist" aria-label="How do you want to pay?">
        <button type="button" role="tab" aria-selected={mode === "full"} className={tab("full")} onClick={() => setMode("full")}>Pay in full</button>
        <button type="button" role="tab" aria-selected={mode === "plan"} className={tab("plan")} onClick={() => setMode("plan")}>Lipa Mdogo Mdogo</button>
      </div>
      <div hidden={mode !== "full"}>{full}</div>
      <div hidden={mode !== "plan"}>{plan}</div>
    </div>
  );
}

export function PlanCheckoutForm({
  reference,
  access,
  idempotencyKey,
  phone,
  totalMinor,
  options,
  terms,
  refundPolicy,
}: {
  reference: string;
  access: string | null;
  idempotencyKey: string;
  phone: string;
  totalMinor: number;
  options: PlanOptionView[];
  terms: string[];
  refundPolicy: string;
}) {
  const [state, action, pending] = useActionState(startPlanAction, {} as FormState);
  const [count, setCount] = useState(Number(state.values?.installmentCount ?? options[options.length - 1].installmentCount));
  const opt = options.find((o) => o.installmentCount === count) ?? options[0];
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-5" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="access" value={access ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="installmentCount" value={opt.installmentCount} />

      <p className="text-sm text-muted">Reserve your tickets with a deposit and pay the rest in installments by M-Pesa. No interest, no late fees.</p>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Number of installments after the deposit</legend>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <button
              type="button"
              key={o.installmentCount}
              aria-pressed={o.installmentCount === opt.installmentCount}
              onClick={() => setCount(o.installmentCount)}
              className={cn("rounded-full border px-4 py-2 text-sm", o.installmentCount === opt.installmentCount ? "border-fg/60 bg-fg/10 font-semibold" : "border-line hover:border-line-strong")}
            >
              {o.installmentCount} {o.installmentCount === 1 ? "payment" : "payments"}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="overflow-hidden rounded-3xl border border-line">
        <table className="w-full text-sm">
          <caption className="sr-only">Payment schedule</caption>
          <tbody>
            {opt.lines.map((l) => (
              <tr key={l.sequence} className={cn("border-b border-line last:border-0", l.sequence === 0 && "bg-fg/5")}>
                <th scope="row" className="px-4 py-3 text-left font-medium">
                  {l.sequence === 0 ? "Deposit (today)" : `Installment ${l.sequence}`}
                  <span className="block text-xs font-normal text-muted">{l.sequence === 0 ? "Paid now to reserve your tickets" : `Due ${l.dueLabel}`}</span>
                </th>
                <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatMoney(l.amountMinor)}</td>
              </tr>
            ))}
            <tr className="bg-fg/5">
              <th scope="row" className="px-4 py-3 text-left font-medium">Total ticket price</th>
              <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatMoney(totalMinor)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="flex items-start gap-2 text-sm text-muted">
        <CalendarClock className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>Remaining balance after the deposit: <strong className="text-fg">{formatMoney(totalMinor - opt.depositMinor)}</strong>. Final deadline: <strong className="text-fg">{opt.finalDueLabel}</strong>. Your entry tickets are issued as soon as everything is paid.</span>
      </p>

      <details className="rounded-3xl border border-line p-4 text-sm" open>
        <summary className="cursor-pointer font-medium">Plan terms, cancellation &amp; refunds</summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-muted">
          {terms.map((t) => <li key={t}>{t}</li>)}
        </ul>
        {refundPolicy && <p className="mt-3 text-xs text-subtle">Event refund policy: {refundPolicy.slice(0, 400)}</p>}
      </details>

      <div className="space-y-1">
        <label className="flex items-start gap-3 text-sm text-fg/85">
          <input type="checkbox" name="planTerms" className="mt-0.5 size-5 shrink-0" aria-invalid={fe.planTerms ? true : undefined} />
          <span>I understand my tickets become valid only after the full balance is paid, and I accept the plan terms above.</span>
        </label>
        {fe.planTerms && <p className="text-xs text-danger">{fe.planTerms}</p>}
      </div>

      <Field label="M-Pesa phone number" htmlFor="plan-phone" error={fe.phone} hint="This number receives the deposit prompt now and the installment prompts later.">
        <Input id="plan-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" defaultValue={state.values?.phone ?? phone} error={fe.phone} />
      </Field>
      <SubmitButton full size="lg" pending={pending} pendingLabel="Sending M-Pesa prompt…">
        Pay deposit with M-Pesa · {formatMoney(opt.depositMinor)}
      </SubmitButton>
      <p className="flex items-start justify-center gap-1.5 text-center text-xs text-subtle">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>Enter your PIN only in the official M-Pesa prompt on your phone. Tikiti will never ask for your M-Pesa PIN.</span>
      </p>
    </form>
  );
}

export function PayInstallmentForm({ reference, access, idempotencyKey, phone, amountMinor, label }: { reference: string; access: string | null; idempotencyKey: string; phone: string; amountMinor: number; label: string }) {
  const [state, action, pending] = useActionState(payInstallmentAction, {} as FormState);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-3" noValidate>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <input type="hidden" name="reference" value={reference} />
      <input type="hidden" name="access" value={access ?? ""} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <Field label="M-Pesa phone number" htmlFor="inst-phone" error={fe.phone}>
        <Input id="inst-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" defaultValue={state.values?.phone ?? phone} error={fe.phone} />
      </Field>
      <SubmitButton full pending={pending} pendingLabel="Sending M-Pesa prompt…">
        <Smartphone className="size-4" aria-hidden /> Pay {label} · {formatMoney(amountMinor)}
      </SubmitButton>
      <p className="text-center text-xs text-subtle">You&apos;ll approve it on your phone. Tikiti never asks for your PIN.</p>
    </form>
  );
}

export type PlanPaymentStatus = {
  payment: { status: string; failureReason: string | null; amountMinor: number; isDeposit: boolean } | null;
  planStatus: string;
  bookingStatus: string;
  paidMinor: number;
  outstandingMinor: number;
};

const FAILED = new Set(["failed", "cancelled", "expired"]);

/** Polls our own server (never M-Pesa) until the installment attempt is final. */
export function PlanPaymentPoller({ reference, paymentId, access, initial }: { reference: string; paymentId: string; access: string | null; initial: PlanPaymentStatus }) {
  const [s, setS] = useState(initial);
  const q = new URLSearchParams({ payment: paymentId, ...(access ? { access } : {}) }).toString();
  const back = `/bookings/${reference}${access ? `?access=${encodeURIComponent(access)}` : ""}`;
  const st = s.payment?.status ?? "pending";
  const done = st === "succeeded" || FAILED.has(st);
  const review = st === "reconciliation_required";

  useEffect(() => {
    if (done) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/bookings/${reference}/plan?${q}`, { cache: "no-store" });
        if (res.ok && !stop) setS(await res.json());
      } catch {
        /* keep polling */
      }
    };
    const t = setInterval(tick, review ? 15_000 : 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [reference, q, done, review]);

  const icon = (cls: string, el: React.ReactNode) => <div className={cn("mx-auto flex size-20 items-center justify-center rounded-full", cls)}>{el}</div>;

  if (st === "succeeded") {
    const complete = s.planStatus === "fully_paid" || s.bookingStatus === "confirmed";
    return (
      <div className="space-y-6 text-center" role="status">
        {icon("bg-success/15 text-success", <CheckCircle2 className="size-10" aria-hidden />)}
        <h1 className="text-2xl font-bold tracking-tight">{complete ? "Fully paid — your tickets are ready!" : s.payment?.isDeposit ? "Deposit received — tickets reserved" : "Installment received"}</h1>
        <p className="text-muted">
          {complete
            ? "Your entry tickets with QR codes have been issued and emailed to you."
            : `${formatMoney(s.paidMinor)} paid so far. Balance: ${formatMoney(s.outstandingMinor)}. Your entry tickets are issued once the balance is paid.`}
        </p>
        <Link href={back} className={buttonClasses("primary", "lg", true)}>{complete ? "View my tickets" : "View my payment plan"}</Link>
      </div>
    );
  }
  if (FAILED.has(st)) {
    return (
      <div className="space-y-6 text-center" role="alert">
        {icon("bg-danger/15 text-danger", <XCircle className="size-10" aria-hidden />)}
        <h1 className="text-2xl font-bold tracking-tight">Payment not completed</h1>
        <p className="text-muted">{s.payment?.failureReason ?? "The M-Pesa payment wasn't completed."} You haven&apos;t been charged for this attempt.</p>
        <Link href={back} className={buttonClasses("primary", "lg", true)}><RotateCcw className="size-5" aria-hidden /> Back to my plan</Link>
      </div>
    );
  }
  if (review) {
    return (
      <div className="space-y-6 text-center" role="status">
        {icon("bg-warning/15 text-warning", <AlertTriangle className="size-10" aria-hidden />)}
        <h1 className="text-2xl font-bold tracking-tight">We&apos;re confirming your payment</h1>
        <p className="text-muted">M-Pesa hasn&apos;t given us a final answer yet. Please don&apos;t pay again — if money left your account it will be applied to your plan or refunded. We&apos;ll email you.</p>
        <Link href={back} className={buttonClasses("secondary", "lg", true)}>Back to my plan</Link>
      </div>
    );
  }
  return (
    <div className="space-y-6 text-center" role="status" aria-live="polite">
      {icon("bg-[#3bb54a]/15 text-[#3bb54a]", st === "created" ? <Loader2 className="size-10 animate-spin" aria-hidden /> : <Smartphone className="size-10" aria-hidden />)}
      <h1 className="text-2xl font-bold tracking-tight">{st === "created" ? "Contacting M-Pesa…" : "Check your phone"}</h1>
      <p className="text-muted">Approve the M-Pesa prompt for {s.payment ? formatMoney(s.payment.amountMinor) : "your installment"} and enter your PIN on your phone — never on this website. Please don&apos;t start another payment.</p>
      <Loader2 className="mx-auto size-5 animate-spin text-muted" aria-hidden />
    </div>
  );
}

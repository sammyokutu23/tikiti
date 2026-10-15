import Link from "next/link";
import { AlertTriangle, Smartphone } from "lucide-react";
import { Alert, Card, StatusBadge } from "@/components/ui";
import { ConfirmButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { randomToken } from "@/lib/crypto";
import { formatPhone } from "@/lib/utils";
import { refundableOnEnd } from "@/server/plans/policy";
import type { PlanView } from "@/server/plans/service";
import { cancelPlanAction } from "./plan-actions";
import { PayInstallmentForm } from "./plan-forms";

const END_REASON: Record<string, string> = {
  missed_installment: "an installment wasn't paid in time",
  deadline_passed: "the balance wasn't paid by the final deadline",
  customer_cancelled: "you cancelled it",
  admin_cancelled: "it was cancelled by Tikiti support",
  event_cancelled: "the event was cancelled",
  hold_expired: "the deposit wasn't paid before the reservation expired",
};

const label = (seq: number, n: number) => (seq === 0 ? "Deposit" : `Installment ${seq} of ${n}`);

/** Customer view of a Lipa Mdogo Mdogo plan on the booking page. */
export function PlanPanel({ view, reference, access, timezone, phone }: { view: PlanView; reference: string; access: string | null; timezone: string; phone: string }) {
  const { plan, installments, payments, next, inFlight } = view;
  const pct = Math.round((plan.paidMinor / plan.totalMinor) * 100);
  const q = access ? `&access=${encodeURIComponent(access)}` : "";
  const cancelRefund = refundableOnEnd(plan.paidMinor, plan.cancellationFeeMinor, "customer_cancelled");
  const ended = ["cancelled", "expired", "refund_pending", "refunded"].includes(plan.status);

  return (
    <Card className="space-y-5 p-5" aria-labelledby="plan-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="plan-h" className="text-lg font-semibold">Lipa Mdogo Mdogo plan</h2>
        <StatusBadge status={plan.status} />
      </div>

      <div className="grid grid-cols-3 gap-3 text-sm">
        <div><p className="text-xs text-muted">Total</p><p className="font-semibold tabular-nums">{formatMoney(plan.totalMinor)}</p></div>
        <div><p className="text-xs text-muted">Paid</p><p className="font-semibold tabular-nums text-success">{formatMoney(plan.paidMinor)}</p></div>
        <div><p className="text-xs text-muted">Balance</p><p className="font-semibold tabular-nums">{formatMoney(view.outstandingMinor)}</p></div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-fg/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Plan progress">
        <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
      </div>

      {plan.status === "fully_paid" && <Alert tone="success">Fully paid — your entry tickets have been issued.</Alert>}
      {(plan.status === "active" || plan.status === "awaiting_deposit") && (
        <p className="text-sm text-muted">
          Your tickets are reserved. Entry tickets with QR codes are issued once the balance is paid — final deadline <strong className="text-fg">{formatDateTime(plan.finalDueAt, timezone)}</strong>.
        </p>
      )}
      {plan.status === "reconciliation_required" && (
        <Alert tone="warning" title="We're reviewing a payment">A payment arrived after your plan ended. Please don&apos;t pay again — we&apos;ll either reinstate your plan or refund it, and email you.</Alert>
      )}
      {ended && (
        <Alert tone="info" title="This plan has ended">
          It ended because {END_REASON[plan.endReason ?? ""] ?? "it was closed"}. The reserved tickets were released.
          {view.refunds.length > 0 && ` Refund${view.refunds.length > 1 ? "s" : ""}: ${view.refunds.map((r) => `${formatMoney(r.amountMinor)} (${r.status === "succeeded" ? "completed" : "in progress"})`).join(", ")}.`}
        </Alert>
      )}

      {inFlight && (
        <Alert tone={inFlight.status === "reconciliation_required" ? "warning" : "info"} title={inFlight.status === "reconciliation_required" ? "Confirming your last payment" : "Payment in progress"}>
          {inFlight.status === "reconciliation_required"
            ? "M-Pesa hasn't confirmed your last payment yet. Please don't pay again."
            : "Approve the M-Pesa prompt on your phone."}{" "}
          <Link href={`/bookings/${reference}/plan/status?payment=${inFlight.id}${q}`} className="underline">See status</Link>
        </Alert>
      )}

      <div className="overflow-hidden rounded-2xl border border-line">
        <table className="w-full text-sm">
          <caption className="sr-only">Installment schedule</caption>
          <thead className="bg-fg/5 text-left text-xs text-muted">
            <tr><th className="px-3 py-2 font-medium">Payment</th><th className="px-3 py-2 font-medium">Due</th><th className="px-3 py-2 text-right font-medium">Amount</th><th className="px-3 py-2 text-right font-medium">Status</th></tr>
          </thead>
          <tbody>
            {installments.map((i) => (
              <tr key={i.id} className="border-t border-line">
                <td className="px-3 py-2.5">{label(i.sequence, plan.installmentCount)}</td>
                <td className="px-3 py-2.5 text-muted">{i.sequence === 0 && i.status === "paid" ? formatDateTime(i.paidAt ?? i.dueAt, timezone) : formatDateTime(i.dueAt, timezone)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{formatMoney(i.amountMinor)}</td>
                <td className="px-3 py-2.5 text-right"><StatusBadge status={i.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {view.canPay && next && (
        <div className="space-y-2 rounded-2xl border border-line p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Smartphone className="size-4" aria-hidden />
            Next: {label(next.sequence, plan.installmentCount)} — {formatMoney(next.amountMinor)}, due {formatDateTime(next.dueAt, timezone)}
          </p>
          {next.status === "overdue" && (
            <p className="flex items-center gap-1.5 text-xs text-danger"><AlertTriangle className="size-3.5" aria-hidden />Overdue. Pay within {view.policy.overdueGraceHours} hours of the due date to keep your tickets.</p>
          )}
          <PayInstallmentForm
            reference={reference}
            access={access}
            idempotencyKey={`inst_${randomToken(18)}`}
            phone={formatPhone(phone)}
            amountMinor={next.amountMinor}
            label={next.sequence === 0 ? "deposit" : `installment ${next.sequence}`}
          />
        </div>
      )}

      {payments.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Payment history ({payments.length})</summary>
          <ul className="mt-2 divide-y divide-line">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-muted">{formatDateTime(p.completedAt ?? p.createdAt, timezone)}</span>
                <span className="tabular-nums">{formatMoney(p.amountMinor)}</span>
                <StatusBadge status={p.status} />
                {p.failureReason && p.status !== "succeeded" && <span className="w-full text-xs text-muted">{p.failureReason}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {view.canCancel && (
        <form action={cancelPlanAction} className="border-t border-line pt-4">
          <input type="hidden" name="reference" value={reference} />
          <input type="hidden" name="access" value={access ?? ""} />
          <p className="mb-2 text-xs text-muted">
            Cancelling releases your tickets.{" "}
            {plan.paidMinor > 0
              ? `${formatMoney(cancelRefund.refundMinor)} would be refunded to your M-Pesa number${cancelRefund.retainedMinor > 0 ? ` (a ${formatMoney(cancelRefund.retainedMinor)} cancellation fee applies)` : ""}.`
              : "Nothing has been paid yet."}
          </p>
          <ConfirmButton variant="ghost" size="sm" message="Cancel your payment plan? Your reserved tickets will be released.">Cancel payment plan</ConfirmButton>
        </form>
      )}
    </Card>
  );
}

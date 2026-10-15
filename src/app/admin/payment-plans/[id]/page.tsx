import Link from "next/link";
import { notFound } from "next/navigation";
import { Flash } from "@/components/dash/flash";
import { Alert, Card, PageHeader, Section, StatusBadge, Table, Textarea } from "@/components/ui";
import { ConfirmButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { requireAdmin } from "@/server/auth/guards";
import { adminPlanDetail } from "@/server/plans/service";
import { adminCancelPlanAction, resolveLatePlanPaymentAction } from "../../actions";

export const metadata = { title: "Payment plan" };

export default async function AdminPlanPage({ params, searchParams }: PageProps<"/admin/payment-plans/[id]">) {
  await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  const d = await adminPlanDetail(id);
  if (!d) notFound();
  const { plan, booking, event } = d;
  const tz = event.timezone;
  const self = `/admin/payment-plans/${plan.id}`;
  const label = (seq: number) => (seq === 0 ? "Deposit" : `Installment ${seq}/${plan.installmentCount}`);

  return (
    <div className="space-y-8">
      <PageHeader
        back={<Link href="/admin/payment-plans" className="text-sm text-muted hover:text-fg">← Payment plans</Link>}
        title={`Plan for ${booking.reference}`}
        subtitle={`${event.title} · ${booking.buyerName} · ${booking.buyerEmail} · ${formatPhone(booking.buyerPhone)}`}
      />
      <Flash sp={sp} />
      <Card className="grid gap-3 p-5 text-sm sm:grid-cols-4">
        <div><p className="text-xs text-muted">Status</p><StatusBadge status={plan.status} /></div>
        <div><p className="text-xs text-muted">Paid / total</p><p className="font-semibold tabular-nums">{formatMoney(plan.paidMinor)} / {formatMoney(plan.totalMinor)}</p></div>
        <div><p className="text-xs text-muted">Final deadline</p><p>{formatDateTime(plan.finalDueAt, tz)}</p></div>
        <div><p className="text-xs text-muted">Booking</p><Link className="underline" href={`/admin/bookings/${booking.id}`}>{booking.status}</Link></div>
        <div className="sm:col-span-4 text-xs text-muted">
          Terms {plan.termsVersion} accepted {formatDateTime(plan.termsAcceptedAt, tz)} · cancellation fee {formatMoney(plan.cancellationFeeMinor)}
          {plan.endReason && ` · ended: ${plan.endReason.replace(/_/g, " ")}`}
        </div>
      </Card>

      {plan.status === "reconciliation_required" && (
        <Alert tone="danger" title="Late payment needs a decision">
          {plan.reconciliationNote} Unapplied verified payment(s): {d.unapplied.map((p) => `${formatMoney(p.amountMinor)} (${p.providerReceipt ?? "no receipt"})`).join(", ") || "none"}.
          <div className="mt-3 flex flex-wrap gap-2">
            <form action={resolveLatePlanPaymentAction}>
              <input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="back" value={self} /><input type="hidden" name="resolution" value="reinstate" />
              <ConfirmButton size="sm" message="Re-hold the tickets (if still available) and apply the payment to the plan?">Reinstate plan & apply payment</ConfirmButton>
            </form>
            <form action={resolveLatePlanPaymentAction}>
              <input type="hidden" name="planId" value={plan.id} /><input type="hidden" name="back" value={self} /><input type="hidden" name="resolution" value="refund" />
              <ConfirmButton size="sm" variant="secondary" message="Refund the late payment(s)?">Refund late payment</ConfirmButton>
            </form>
          </div>
        </Alert>
      )}

      <Section title="Schedule">
        <Table>
          <thead><tr><th>Payment</th><th>Due</th><th>Amount</th><th>Status</th><th>Paid at</th></tr></thead>
          <tbody>
            {d.installments.map((i) => (
              <tr key={i.id}>
                <td>{label(i.sequence)}</td>
                <td className="whitespace-nowrap">{formatDateTime(i.dueAt, tz)}</td>
                <td className="tabular-nums">{formatMoney(i.amountMinor)}</td>
                <td><StatusBadge status={i.status} /></td>
                <td className="whitespace-nowrap">{i.paidAt ? formatDateTime(i.paidAt, tz) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>

      <Section title="Payment attempts">
        <Table>
          <thead><tr><th>Created</th><th>Installment</th><th>Amount</th><th>Status</th><th>Provider</th><th>Receipt</th><th>Note</th></tr></thead>
          <tbody>
            {d.payments.map((p) => (
              <tr key={p.id}>
                <td className="whitespace-nowrap">{formatDateTime(p.createdAt, tz)}</td>
                <td>{p.installmentId ? label(d.installments.find((i) => i.id === p.installmentId)?.sequence ?? -1) : "full payment"}</td>
                <td className="tabular-nums">{formatMoney(p.amountMinor)}</td>
                <td><StatusBadge status={p.status} /></td>
                <td>{p.provider}</td>
                <td className="font-mono text-xs">{p.providerReceipt ?? "—"}</td>
                <td className="text-xs text-muted">{p.failureReason ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-xs text-muted">Unresolved M-Pesa attempts can be checked or resolved from <Link href="/admin/operations" className="underline">Operations</Link>.</p>
      </Section>

      {d.refunds.length > 0 && (
        <Section title="Refunds">
          <Table>
            <thead><tr><th>Created</th><th>Amount</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>
              {d.refunds.map((r) => (
                <tr key={r.id}><td>{formatDateTime(r.createdAt, tz)}</td><td className="tabular-nums">{formatMoney(r.amountMinor)}</td><td><StatusBadge status={r.status} /></td><td className="text-xs">{r.reason}</td></tr>
              ))}
            </tbody>
          </Table>
          <p className="text-xs text-muted">M-Pesa refunds marked “Manual reversal” are completed in the M-Pesa org portal and recorded from Operations.</p>
        </Section>
      )}

      {(plan.status === "active" || plan.status === "awaiting_deposit") && (
        <Section title="Cancel plan">
          <Card className="p-5">
            <form action={adminCancelPlanAction} className="space-y-3">
              <input type="hidden" name="planId" value={plan.id} />
              <input type="hidden" name="back" value={self} />
              <Textarea name="reason" rows={2} placeholder="Reason (recorded in the audit log and kept internal)" />
              <ConfirmButton variant="danger" message="Cancel this plan? Tickets are released and everything paid is refunded in full.">Cancel plan & refund in full</ConfirmButton>
            </form>
          </Card>
        </Section>
      )}
    </div>
  );
}

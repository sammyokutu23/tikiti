import Link from "next/link";
import { Flash } from "@/components/dash/flash";
import { Card, Field, Input, PageHeader, Section, StatusBadge, Table, Tabs } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { requireAdmin } from "@/server/auth/guards";
import { getPlanPolicy } from "@/server/plans/policy";
import { adminPlans } from "@/server/plans/service";
import { setPlanPolicyAction } from "../actions";

export const metadata = { title: "Payment plans" };

export default async function AdminPlansPage({ searchParams }: PageProps<"/admin/payment-plans">) {
  await requireAdmin();
  const sp = await searchParams;
  const tab = sp.tab === "active" || sp.tab === "all" ? sp.tab : "attention";
  const [policy, { rows }] = await Promise.all([getPlanPolicy(), adminPlans(tab)]);

  return (
    <div className="space-y-8">
      <PageHeader title="Payment plans" subtitle="Lipa Mdogo Mdogo: installment policy, overdue plans, late payments and refunds." />
      <Flash sp={sp} />

      <Section title="Plans">
        <Tabs
          active={tab}
          items={[
            { key: "attention", label: "Needs attention", href: "/admin/payment-plans" },
            { key: "active", label: "Active", href: "/admin/payment-plans?tab=active" },
            { key: "all", label: "All", href: "/admin/payment-plans?tab=all" },
          ]}
        />
        <Table>
          <thead><tr><th>Booking</th><th>Buyer</th><th>Event</th><th>Organizer</th><th>Status</th><th>Paid / total</th><th>Final deadline</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.plan.id}>
                <td className="font-mono text-xs">{r.reference}</td>
                <td>{r.buyerName}<span className="block text-xs text-muted">{r.buyerEmail}</span></td>
                <td>{r.eventTitle}</td>
                <td>{r.organizer}</td>
                <td><StatusBadge status={r.plan.status} />{r.plan.reconciliationNote && <span className="block text-xs text-danger">{r.plan.reconciliationNote}</span>}</td>
                <td className="tabular-nums">{formatMoney(r.plan.paidMinor)} / {formatMoney(r.plan.totalMinor)}</td>
                <td className="whitespace-nowrap">{formatDateTime(r.plan.finalDueAt)}</td>
                <td><Link href={`/admin/payment-plans/${r.plan.id}`} className="text-sm underline">Open</Link></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="text-muted">Nothing here.</td></tr>}
          </tbody>
        </Table>
      </Section>

      <Section title="Installment policy">
        <Card className="space-y-4 p-5">
          <p className="text-sm text-muted">Applies to <strong>new</strong> plans. Each plan stores the policy the customer accepted, so changes never alter an existing schedule. No interest or late fees are ever charged.</p>
          <form action={setPlanPolicyAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-3">
              <input type="checkbox" name="enabled" defaultChecked={policy.enabled} className="size-4" /> Payment plans enabled platform-wide (organizers still opt in per event)
            </label>
            <Field label="Deposit (%)" htmlFor="dep"><Input id="dep" name="depositPercent" type="number" min={5} max={90} step="1" defaultValue={policy.depositBps / 100} /></Field>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Installment options (after deposit)</legend>
              <div className="flex flex-wrap gap-3 pt-2">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <label key={n} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="installmentOptions" value={n} defaultChecked={policy.installmentOptions.includes(n)} />{n}</label>
                ))}
              </div>
            </fieldset>
            <Field label="Min. days before event to start a plan" htmlFor="mdb"><Input id="mdb" name="minDaysBeforeEvent" type="number" min={2} max={180} defaultValue={policy.minDaysBeforeEvent} /></Field>
            <Field label="Final deadline (hours before event)" htmlFor="fdh"><Input id="fdh" name="finalDeadlineHours" type="number" min={24} max={720} defaultValue={policy.finalDeadlineHours} /></Field>
            <Field label="Min. days between payments" htmlFor="mdp"><Input id="mdp" name="minDaysBetweenPayments" type="number" min={0.5} max={60} step="0.5" defaultValue={policy.minDaysBetweenPayments} /></Field>
            <Field label="Overdue grace (hours)" htmlFor="og" hint="Then the plan ends and tickets are released."><Input id="og" name="overdueGraceHours" type="number" min={0} max={336} defaultValue={policy.overdueGraceHours} /></Field>
            <Field label="Reminder (days before due)" htmlFor="rd"><Input id="rd" name="reminderDaysBefore" type="number" min={1} max={14} defaultValue={policy.reminderDaysBefore} /></Field>
            <Field label="Min. order total (KES)" htmlFor="mt"><Input id="mt" name="minBookingTotalKes" type="number" min={1} defaultValue={policy.minBookingTotalKes} /></Field>
            <Field label="Min. installment (KES)" htmlFor="mi"><Input id="mi" name="minInstallmentKes" type="number" min={1} defaultValue={policy.minInstallmentKes} /></Field>
            <Field label="Cancellation fee (%)" htmlFor="cf" hint="Kept when a plan ends early. 0 = full refund. Event/admin cancellations always refund in full."><Input id="cf" name="cancellationFeePercent" type="number" min={0} max={20} step="0.5" defaultValue={policy.cancellationFeeBps / 100} /></Field>
            <div className="flex items-end"><SubmitButton>Save policy</SubmitButton></div>
          </form>
        </Card>
      </Section>
    </div>
  );
}

import { CalendarClock } from "lucide-react";
import { Card, EmptyState, PageHeader, Section, Stat, StatusBadge, Table } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { requireOrganizer } from "@/server/auth/guards";
import { organizerPlans } from "@/server/plans/service";

export const metadata = { title: "Payment plans" };

/** Lipa Mdogo Mdogo activity for this organizer's own events only (no buyer contact details). */
export default async function OrganizerPlansPage() {
  const ctx = await requireOrganizer();
  const { rows, stats, upcoming } = await organizerPlans(ctx.organizer.id);
  return (
    <div className="space-y-8">
      <PageHeader title="Payment plans" subtitle="Lipa Mdogo Mdogo bookings: deposits and installments collected via M-Pesa. Tickets are issued only when a plan is fully paid." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Active plans" value={stats.active} />
        <Stat label="Collected (active)" value={formatMoney(stats.collectedMinor)} />
        <Stat label="Outstanding" value={formatMoney(stats.outstandingMinor)} />
        <Stat label="Fully paid" value={stats.fullyPaid} />
        <Stat label="Ended / refunded" value={stats.ended} />
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={<CalendarClock className="size-6" />} title="No payment plans yet" body="Turn on “Lipa Mdogo Mdogo” in an event's details to let buyers pay in installments." />
      ) : (
        <>
          <Section title="Upcoming deadlines">
            {upcoming.length === 0 ? (
              <Card className="p-5 text-sm text-muted">No installments due soon.</Card>
            ) : (
              <Table>
                <thead><tr><th>Due</th><th>Event</th><th>Booking</th><th>Balance</th></tr></thead>
                <tbody>
                  {upcoming.map((r) => (
                    <tr key={r.plan.id}>
                      <td className="whitespace-nowrap">{formatDateTime(r.nextDueAt!, r.timezone)}</td>
                      <td>{r.eventTitle}</td>
                      <td className="font-mono text-xs">{r.reference}</td>
                      <td className="tabular-nums">{formatMoney(r.plan.totalMinor - r.plan.paidMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Section>
          <Section title="All plans">
            <Table>
              <thead><tr><th>Booking</th><th>Buyer</th><th>Event</th><th>Status</th><th>Paid</th><th>Outstanding</th><th>Final deadline</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.plan.id}>
                    <td className="font-mono text-xs">{r.reference}</td>
                    <td>{r.buyerName}</td>
                    <td>{r.eventTitle}</td>
                    <td><StatusBadge status={r.plan.status} /></td>
                    <td className="tabular-nums">{formatMoney(r.plan.paidMinor)}</td>
                    <td className="tabular-nums">{formatMoney(r.plan.totalMinor - r.plan.paidMinor)}</td>
                    <td className="whitespace-nowrap">{formatDateTime(r.plan.finalDueAt, r.timezone)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Section>
        </>
      )}
    </div>
  );
}

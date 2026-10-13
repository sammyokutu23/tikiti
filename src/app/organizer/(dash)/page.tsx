import Link from "next/link";
import { CalendarPlus } from "lucide-react";
import { FinanceBreakdown } from "@/components/dash/finance";
import { Alert, ButtonLink, EmptyState, PageHeader, Section, Stat, StatusBadge, Table } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";
import { canPublish, requireOrganizer } from "@/server/auth/guards";
import { organizerEvents } from "@/server/events/queries";
import { organizerOverview } from "@/server/organizers/reports";

export const metadata = { title: "Organizer dashboard" };

export default async function OrganizerHome() {
  const { user, organizer } = await requireOrganizer();
  const [o, evs] = await Promise.all([organizerOverview(organizer.id), organizerEvents(organizer.id)]);
  const upcoming = evs.filter((e) => e.endsAt > new Date() && e.status !== "cancelled").slice(0, 5);
  const rate = o.issued ? Math.round((o.checkedIn / o.issued) * 100) : 0;

  return (
    <div className="space-y-8">
      <PageHeader title="Overview" subtitle="Sales, attendance and estimated proceeds across your events." actions={<ButtonLink href="/organizer/events/new"><CalendarPlus className="size-4" aria-hidden />New event</ButtonLink>} />

      {organizer.verificationStatus === "pending" && (
        <Alert tone="warning" title="Verification pending">
          You can create and preview draft events now. Publishing and payouts unlock once our team verifies your account.
        </Alert>
      )}
      {organizer.verificationStatus === "suspended" && (
        <Alert tone="danger" title="Account suspended">Your events are hidden from the public. Contact support. {organizer.verificationNote}</Alert>
      )}
      {organizer.verificationStatus === "verified" && !canPublish(user, organizer) && (
        <Alert tone="warning">Your organizer role is being updated. Please log out and back in.</Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Gross ticket sales" value={formatAmount(o.finance.grossSalesMinor)} />
        <Stat label="Tickets sold" value={o.ticketsSold.toLocaleString()} />
        <Stat label="Remaining inventory" value={o.remaining.toLocaleString()} hint="Across active ticket types" />
        <Stat label="Attendance" value={`${rate}%`} hint={`${o.checkedIn} of ${o.issued} valid tickets checked in`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Earnings">
          <FinanceBreakdown f={o.finance} />
        </Section>
        <Section title="Upcoming events" action={<Link href="/organizer/events" className="text-sm text-muted hover:text-fg">All events</Link>}>
          {upcoming.length === 0 ? (
            <EmptyState title="No upcoming events" body="Create your first event to start selling." action={<ButtonLink href="/organizer/events/new">Create event</ButtonLink>} />
          ) : (
            <ul className="space-y-2">
              {upcoming.map((e) => (
                <li key={e.id}>
                  <Link href={`/organizer/events/${e.id}`} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface/60 p-4 hover:border-line-strong">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{e.title}</p>
                      <p className="text-xs text-muted">{formatDateTime(e.startsAt, e.timezone)}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusBadge status={e.status} />
                      <span className="text-xs tabular-nums text-muted">{e.sold}/{e.capacity} sold</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Recent bookings" action={<Link href="/organizer/bookings" className="text-sm text-muted hover:text-fg">All bookings</Link>}>
        {o.recent.length === 0 ? (
          <EmptyState title="No bookings yet" body="Bookings will appear here as soon as you make your first sale." />
        ) : (
          <Table>
            <thead><tr><th>Reference</th><th>Buyer</th><th>Event</th><th>Qty</th><th>Total</th><th>Commission</th><th>Status</th></tr></thead>
            <tbody>
              {o.recent.map((b) => (
                <tr key={b.id}>
                  <td className="font-mono text-xs">{b.reference}</td>
                  <td>{b.buyerName}</td>
                  <td className="max-w-48 truncate">{b.eventTitle}</td>
                  <td className="tabular-nums">{b.quantity}</td>
                  <td className="tabular-nums">{formatMoney(b.totalMinor)}</td>
                  <td className="tabular-nums text-muted">{formatAmount(b.commissionMinor)}</td>
                  <td><StatusBadge status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>
    </div>
  );
}

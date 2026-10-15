import { Search } from "lucide-react";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { EmptyState, PageHeader, StatusBadge, Table } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";
import { requireOrganizer } from "@/server/auth/guards";
import { recentBookings } from "@/server/organizers/reports";

export const metadata = { title: "Bookings" };

export default async function OrganizerBookingsPage({ searchParams }: PageProps<"/organizer/bookings">) {
  const { organizer } = await requireOrganizer();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const ids = (await db.select({ id: events.id }).from(events).where(eq(events.organizerId, organizer.id))).map((e) => e.id);
  const rows = await recentBookings({ eventIds: ids, q, limit: 300 });
  return (
    <div className="space-y-6">
      <PageHeader title="Bookings" subtitle="Every booking across your events." />
      <form className="relative max-w-lg" role="search">
        <label htmlFor="bq" className="sr-only">Search bookings</label>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input id="bq" name="q" defaultValue={q} placeholder="Name, email, reference or ticket code" className="h-12 w-full rounded-full border border-line bg-fg/5 pl-11 pr-4 text-sm focus:border-fg/40 focus:outline-none" />
      </form>
      {rows.length === 0 ? (
        <EmptyState title={q ? "No bookings match" : "No bookings yet"} />
      ) : (
        <Table>
          <thead><tr><th>Reference</th><th>Buyer</th><th>Event</th><th>Qty</th><th>Total</th><th>Commission</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td className="font-mono text-xs">{b.reference}</td>
                <td><p>{b.buyerName}</p><p className="text-xs text-muted">{b.buyerEmail}</p></td>
                <td className="max-w-48 truncate">{b.eventTitle}</td>
                <td className="tabular-nums">{b.quantity}</td>
                <td className="tabular-nums">{formatMoney(b.totalMinor)}</td>
                <td className="tabular-nums text-muted">{formatAmount(b.commissionMinor)}</td>
                <td><StatusBadge status={b.status} /></td>
                <td className="text-xs text-muted">{formatDateTime(b.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

import Link from "next/link";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { Search } from "lucide-react";
import { db } from "@/db";
import { bookings, events } from "@/db/schema";
import { EmptyState, PageHeader, StatusBadge, Table } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";

export const metadata = { title: "Bookings" };

export default async function AdminBookings({ searchParams }: PageProps<"/admin/bookings">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().slice(0, 100) : "";
  const eventId = typeof sp.event === "string" && /^[0-9a-f-]{36}$/.test(sp.event) ? sp.event : null;
  const conds: SQL[] = [];
  if (q) {
    const t = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    conds.push(or(ilike(bookings.reference, t), ilike(bookings.buyerEmail, t), ilike(bookings.buyerName, t), ilike(bookings.buyerPhone, t), ilike(events.title, t))!);
  }
  if (eventId) conds.push(eq(bookings.eventId, eventId));
  const rows = await db
    .select({ b: bookings, title: events.title })
    .from(bookings)
    .innerJoin(events, eq(events.id, bookings.eventId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(bookings.createdAt))
    .limit(300);
  return (
    <div className="space-y-6">
      <PageHeader title="Bookings & transactions" subtitle="Inspect bookings, payments, refunds and email delivery." />
      <form className="relative max-w-lg" role="search">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <label htmlFor="abq" className="sr-only">Search</label>
        <input id="abq" name="q" defaultValue={q} placeholder="Reference, buyer email/name/phone or event" className="h-12 w-full rounded-full border border-line bg-white/5 pl-11 pr-4 text-sm focus:outline-none" />
      </form>
      {rows.length === 0 ? (
        <EmptyState title="No bookings found" />
      ) : (
        <Table>
          <thead><tr><th>Reference</th><th>Buyer</th><th>Event</th><th>Total</th><th>Commission</th><th>Status</th><th>Payment</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map(({ b, title }) => (
              <tr key={b.id}>
                <td><Link href={`/admin/bookings/${b.id}`} className="font-mono text-xs underline-offset-4 hover:underline">{b.reference}</Link></td>
                <td><p>{b.buyerName}</p><p className="text-xs text-muted">{b.buyerEmail}</p></td>
                <td className="max-w-48 truncate">{title}</td>
                <td className="tabular-nums">{formatMoney(b.totalMinor)}</td>
                <td className="tabular-nums text-muted">{formatAmount(b.commissionMinor)} <span className="text-xs">({b.commissionBps / 100}%)</span></td>
                <td><StatusBadge status={b.status} /></td>
                <td><StatusBadge status={b.paymentStatus} /></td>
                <td className="text-xs text-muted">{formatDateTime(b.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

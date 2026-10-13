import Link from "next/link";
import { Download, Search, Users } from "lucide-react";
import { Flash } from "@/components/dash/flash";
import { buttonClasses, EmptyState, PageHeader, StatusBadge, Table } from "@/components/ui";
import { ConfirmButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/utils";
import { attendeesForEvent, recentBookings } from "@/server/organizers/reports";
import { organizerEventPage } from "@/server/organizers/access";
import { refundBookingAction } from "@/app/organizer/actions";

export const metadata = { title: "Attendees" };

export default async function AttendeesPage({ params, searchParams }: PageProps<"/organizer/events/[id]/attendees">) {
  const { id } = await params;
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const { event } = await organizerEventPage(id);
  const [rows, bookingRows] = await Promise.all([attendeesForEvent(event.id, q), recentBookings({ eventIds: [event.id], q, limit: 200 })]);
  const back = `/organizer/events/${event.id}/attendees${q ? `?q=${encodeURIComponent(q)}` : ""}`;

  return (
    <div className="space-y-8">
      <PageHeader
        back={<Link href={`/organizer/events/${event.id}`} className="text-sm text-muted hover:text-fg">← {event.title}</Link>}
        title="Attendees & bookings"
        subtitle={`${rows.length} ticket${rows.length === 1 ? "" : "s"}${q ? ` matching “${q}”` : ""}`}
        actions={
          <a href={`/api/organizer/events/${event.id}/attendees`} className={buttonClasses("secondary", "sm")}>
            <Download className="size-4" aria-hidden /> Export CSV
          </a>
        }
      />
      <Flash sp={sp} />
      <form className="relative max-w-lg" role="search">
        <label htmlFor="aq" className="sr-only">Search attendees</label>
        <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
        <input id="aq" name="q" defaultValue={q} placeholder="Name, email, booking ref or ticket code" className="h-12 w-full rounded-full border border-line bg-white/5 pl-11 pr-4 text-sm focus:border-white/40 focus:outline-none" />
      </form>

      {rows.length === 0 ? (
        <EmptyState icon={<Users className="size-6" />} title={q ? "No matching attendees" : "No tickets issued yet"} body={q ? "Try another name, email or code." : "Attendees appear here after confirmed bookings."} />
      ) : (
        <Table>
          <thead><tr><th>Ticket</th><th>Type</th><th>Attendee / buyer</th><th>Booking</th><th>Status</th><th>Checked in</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/organizer/events/${event.id}/tickets/${r.id}`} className="font-mono text-xs underline-offset-4 hover:underline">{r.code}</Link></td>
                <td>{r.ticketType}</td>
                <td>
                  <p>{r.attendeeName ?? r.buyerName}</p>
                  <p className="text-xs text-muted">{r.buyerEmail} · {formatPhone(r.buyerPhone)}</p>
                </td>
                <td className="font-mono text-xs">{r.reference}</td>
                <td><StatusBadge status={r.status} /></td>
                <td className="text-xs text-muted">{r.checkedInAt ? formatDateTime(r.checkedInAt, event.timezone) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Bookings</h2>
        {bookingRows.length === 0 ? (
          <p className="text-sm text-muted">No bookings{q ? " match your search" : " yet"}.</p>
        ) : (
          <Table>
            <thead><tr><th>Reference</th><th>Buyer</th><th>Qty</th><th>Total</th><th>Status</th><th>Payment</th><th /></tr></thead>
            <tbody>
              {bookingRows.map((b) => (
                <tr key={b.id}>
                  <td className="font-mono text-xs">{b.reference}</td>
                  <td><p>{b.buyerName}</p><p className="text-xs text-muted">{b.buyerEmail}</p></td>
                  <td className="tabular-nums">{b.quantity}</td>
                  <td className="tabular-nums">KES {(b.totalMinor / 100).toLocaleString()}</td>
                  <td><StatusBadge status={b.status} /></td>
                  <td><StatusBadge status={b.paymentStatus} /></td>
                  <td>
                    {b.status === "confirmed" && (
                      <form action={refundBookingAction}>
                        <input type="hidden" name="bookingId" value={b.id} />
                        <input type="hidden" name="back" value={back} />
                        <ConfirmButton variant="ghost" size="sm" message={`Refund ${b.reference} in full and invalidate its tickets?`}>Refund</ConfirmButton>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </div>
  );
}

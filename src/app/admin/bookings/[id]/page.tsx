import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { checkIns, ledgerEntries, paymentEvents, users } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Card, Input, PageHeader, Section, StatusBadge, Table } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";
import { formatPhone } from "@/lib/utils";
import { bookingDetail } from "@/server/bookings/queries";
import { adminRefundAction, retryEmailAction } from "../../actions";

export const metadata = { title: "Booking" };

export default async function AdminBookingDetail({ params, searchParams }: PageProps<"/admin/bookings/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const d = await bookingDetail(id);
  if (!d) notFound();
  const { booking, event } = d;
  const refs = d.payments.map((p) => p.providerReference).filter(Boolean) as string[];
  const [webhooks, ledger, scans] = await Promise.all([
    refs.length ? db.select().from(paymentEvents).where(inArray(paymentEvents.providerReference, refs)).orderBy(desc(paymentEvents.createdAt)) : Promise.resolve([]),
    db.select().from(ledgerEntries).where(eq(ledgerEntries.bookingId, id)).orderBy(ledgerEntries.createdAt),
    d.tickets.length
      ? db.select({ c: checkIns, by: users.name }).from(checkIns).innerJoin(users, eq(users.id, checkIns.scannedBy)).where(inArray(checkIns.ticketId, d.tickets.map((t) => t.ticket.id))).orderBy(desc(checkIns.createdAt))
      : Promise.resolve([]),
  ]);
  const back = `/admin/bookings/${id}`;

  return (
    <div className="space-y-8">
      <PageHeader back={<Link href="/admin/bookings" className="text-sm text-muted hover:text-fg">← Bookings</Link>} title={<span className="font-mono">{booking.reference}</span>} subtitle={`${event.title} · ${formatDateTime(event.startsAt, event.timezone)}`} />
      <Flash sp={sp} />
      <div className="grid gap-4 md:grid-cols-3">
        <Card className="space-y-2 p-5 text-sm">
          <div className="flex gap-2"><StatusBadge status={booking.status} /><StatusBadge status={booking.paymentStatus} /></div>
          <p>{booking.buyerName}</p>
          <p className="text-muted">{booking.buyerEmail} · {formatPhone(booking.buyerPhone)}</p>
          <p className="text-muted">{booking.userId ? "Registered customer" : "Guest checkout"}</p>
          <p className="text-muted">Created {formatDateTime(booking.createdAt)}{booking.confirmedAt ? ` · confirmed ${formatDateTime(booking.confirmedAt)}` : ""}</p>
        </Card>
        <Card className="space-y-1.5 p-5 text-sm">
          {d.items.map((i) => <p key={i.id} className="flex justify-between"><span>{i.quantity} × {i.ticketTypeName}</span><span className="tabular-nums">{formatAmount(i.lineTotalMinor)}</span></p>)}
          <p className="flex justify-between border-t border-line pt-1.5 font-semibold"><span>Total</span><span className="tabular-nums">{formatMoney(booking.totalMinor)}</span></p>
          <p className="flex justify-between text-muted"><span>Commission ({booking.commissionBps / 100}%)</span><span className="tabular-nums">{formatAmount(booking.commissionMinor)}</span></p>
          <p className="flex justify-between text-muted"><span>Organizer est.</span><span className="tabular-nums">{formatAmount(booking.subtotalMinor - booking.commissionMinor)}</span></p>
        </Card>
        {booking.status === "confirmed" ? (
          <Card className="space-y-3 p-5">
            <p className="text-sm font-semibold">Refund booking</p>
            <form action={adminRefundAction} className="space-y-2">
              <input type="hidden" name="bookingId" value={booking.id} />
              <input type="hidden" name="back" value={back} />
              <Input name="reason" placeholder="Reason" />
              <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" name="returnInventory" defaultChecked className="accent-white" /> Return tickets to sale</label>
              <ConfirmButton variant="danger" size="sm" message="Refund this booking in full and invalidate its tickets?">Refund {formatMoney(booking.totalMinor)}</ConfirmButton>
            </form>
          </Card>
        ) : (
          <Card className="p-5 text-sm text-muted">No refund action available for a {booking.status} booking.</Card>
        )}
      </div>

      <Section title="Payments">
        <Table>
          <thead><tr><th>Provider ref</th><th>Method</th><th>Amount</th><th>Status</th><th>Reason</th><th>Created</th></tr></thead>
          <tbody>{d.payments.length === 0 ? <tr><td colSpan={6} className="text-muted">No payment attempts (free booking or abandoned).</td></tr> : d.payments.map((p) => <tr key={p.id}><td className="font-mono text-xs">{p.providerReference}</td><td>{p.provider}/{p.method}</td><td className="tabular-nums">{formatMoney(p.amountMinor)}</td><td><StatusBadge status={p.status} /></td><td className="text-xs text-muted">{p.failureReason}</td><td className="text-xs text-muted">{formatDateTime(p.createdAt)}</td></tr>)}</tbody>
        </Table>
      </Section>

      <Section title="Provider callbacks">
        <Table>
          <thead><tr><th>Event id</th><th>Signature</th><th>Outcome</th><th>Received</th></tr></thead>
          <tbody>{webhooks.length === 0 ? <tr><td colSpan={4} className="text-muted">None.</td></tr> : webhooks.map((w) => <tr key={w.id}><td className="font-mono text-xs">{w.providerEventId}</td><td>{w.signatureValid ? "valid" : "INVALID"}</td><td className="text-xs">{w.outcome}</td><td className="text-xs text-muted">{formatDateTime(w.createdAt)}</td></tr>)}</tbody>
        </Table>
      </Section>

      <Section title="Tickets">
        <Table>
          <thead><tr><th>Code</th><th>Type</th><th>Status</th><th>Checked in</th></tr></thead>
          <tbody>{d.tickets.length === 0 ? <tr><td colSpan={4} className="text-muted">No tickets issued.</td></tr> : d.tickets.map(({ ticket, typeName }) => <tr key={ticket.id}><td><Link href={`/admin/tickets?code=${ticket.code}`} className="font-mono text-xs hover:underline">{ticket.code}</Link></td><td>{typeName}</td><td><StatusBadge status={ticket.status} /></td><td className="text-xs text-muted">{ticket.checkedInAt ? formatDateTime(ticket.checkedInAt) : "—"}</td></tr>)}</tbody>
        </Table>
        {scans.length > 0 && <p className="text-xs text-muted">{scans.length} scan attempt(s); latest {formatDateTime(scans[0].c.createdAt)} by {scans[0].by} ({scans[0].c.result}).</p>}
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Ledger entries">
          <Table className="[&_table]:min-w-0">
            <thead><tr><th>Type</th><th>Amount</th></tr></thead>
            <tbody>{ledger.length === 0 ? <tr><td colSpan={2} className="text-muted">None.</td></tr> : ledger.map((l) => <tr key={l.id}><td>{l.type.replace(/_/g, " ")}</td><td className="tabular-nums">{formatAmount(l.amountMinor)}</td></tr>)}</tbody>
          </Table>
        </Section>
        <Section title="Refunds">
          <Table className="[&_table]:min-w-0">
            <thead><tr><th>Amount</th><th>Status</th><th>Reason</th></tr></thead>
            <tbody>{d.refunds.length === 0 ? <tr><td colSpan={3} className="text-muted">None.</td></tr> : d.refunds.map((r) => <tr key={r.id}><td className="tabular-nums">{formatMoney(r.amountMinor)}</td><td><StatusBadge status={r.status} /></td><td className="text-xs">{r.reason}</td></tr>)}</tbody>
          </Table>
        </Section>
      </div>

      <Section title="Emails">
        <Table>
          <thead><tr><th>Kind</th><th>To</th><th>Status</th><th>Attempts</th><th>Last error</th><th /></tr></thead>
          <tbody>
            {d.emails.length === 0 ? <tr><td colSpan={6} className="text-muted">None.</td></tr> : d.emails.map((e) => (
              <tr key={e.id}>
                <td>{e.kind.replace(/_/g, " ")}</td><td className="text-xs">{e.toEmail}</td><td><StatusBadge status={e.status} /></td><td>{e.attempts}</td><td className="max-w-56 truncate text-xs text-danger">{e.lastError}</td>
                <td>
                  <form action={retryEmailAction}>
                    <input type="hidden" name="deliveryId" value={e.id} />
                    <input type="hidden" name="back" value={back} />
                    <SubmitButton size="sm" variant="ghost">{e.status === "failed" || e.status === "queued" ? "Retry" : "Resend"}</SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </div>
  );
}

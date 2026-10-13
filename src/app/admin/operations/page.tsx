import Link from "next/link";
import { desc, ne } from "drizzle-orm";
import { db } from "@/db";
import { jobs, paymentEvents, type EmailDelivery } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { PageHeader, Section, StatusBadge, Table } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { inputClasses } from "@/components/ui";
import { mpesaAttentionItems, describePayer } from "@/server/payments/mpesa";
import { checkoutPaymentModes } from "@/server/payments/options";
import { darajaConfigStatus } from "@/server/payments/providers/daraja/config";
import { env } from "@/lib/env";
import { canRetryInPlace, emailOperationsView } from "@/server/email/admin";
import { resendConfigStatus } from "@/server/email/resend";
import {
  checkSenderDomainAction,
  mpesaCheckStatusAction,
  mpesaResolveAction,
  recordManualRefundAction,
  refreshEmailStatusAction,
  removeSuppressionAction,
  resendEmailAction,
  retryConfigFailuresAction,
  retryEmailAction,
  retryJobAction,
  runWorkerAction,
} from "../actions";

export const metadata = { title: "Operations" };

export default async function AdminOps({ searchParams }: PageProps<"/admin/operations">) {
  const sp = await searchParams;
  const modes = checkoutPaymentModes();
  const daraja = env.mpesaProvider === "daraja" ? darajaConfigStatus() : null;
  const resend = env.emailTransport === "resend" ? resendConfigStatus() : null;
  const [jobRows, mail, hooks, attention] = await Promise.all([
    db.select().from(jobs).where(ne(jobs.status, "succeeded")).orderBy(desc(jobs.updatedAt)).limit(50),
    emailOperationsView(),
    db.select().from(paymentEvents).orderBy(desc(paymentEvents.createdAt)).limit(30),
    mpesaAttentionItems(),
  ]);
  const attentionCount = attention.payments.length + attention.manualRefunds.length + attention.orphanCallbacks.length;
  return (
    <div className="space-y-8">
      <PageHeader
        title="Operations"
        subtitle={`Email: ${env.emailTransport}${env.emailTransport === "dev-capture" ? " (captured locally, not delivered)" : resend?.ok ? ` from ${resend.fromEmail}` : ""} · M-Pesa: ${env.mpesaProvider} (${modes.mpesa}) · Card: ${env.cardProvider} (${modes.card})`}
        actions={
          <form action={runWorkerAction}>
            <SubmitButton size="sm" variant="secondary">Run worker now</SubmitButton>
          </form>
        }
      />
      <Flash sp={sp} />
      {resend && !resend.ok && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">Resend is selected but not usable: {resend.error}. Emails will fail until this is fixed.</p>
      )}
      {resend?.ok && resend.testSender && (
        <p role="alert" className="rounded-2xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm">Sending from Resend&rsquo;s test address: only your own Resend account email receives messages. Verify a domain before taking real bookings.</p>
      )}
      {daraja && !daraja.ok && (
        <p role="alert" className="rounded-2xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">M-Pesa (Daraja) is selected but not usable: {daraja.error}</p>
      )}
      <Section title={`M-Pesa payments needing attention (${attentionCount})`}>
        <div className="space-y-4">
          <Table>
            <thead><tr><th>Started</th><th>Booking</th><th>Payer</th><th>Amount</th><th>Status</th><th>Reason</th><th>Checks</th><th>Actions</th></tr></thead>
            <tbody>
              {attention.payments.length === 0 ? <tr><td colSpan={8} className="text-muted">No unresolved M-Pesa attempts.</td></tr> : attention.payments.map(({ p, reference, bookingStatus }) => (
                <tr key={p.id}>
                  <td className="text-xs">{formatDateTime(p.createdAt)}</td>
                  <td className="font-mono text-xs"><Link href={`/admin/bookings/${p.bookingId}`} className="hover:underline">{reference}</Link><span className="block text-muted">{bookingStatus}</span></td>
                  <td className="text-xs">{describePayer(p.payerPhone)}</td>
                  <td className="tabular-nums">{formatMoney(p.amountMinor)}</td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="max-w-56 text-xs text-muted">{p.failureReason ?? "Awaiting result"}{p.providerReference ? <span className="block font-mono">{p.providerReference}</span> : <span className="block">No CheckoutRequestID</span>}</td>
                  <td className="text-xs">{p.statusCheckAttempts}{p.lastStatusCheckAt ? <span className="block text-muted">last {formatDateTime(p.lastStatusCheckAt)}</span> : null}</td>
                  <td className="space-y-2">
                    {p.providerReference && (
                      <form action={mpesaCheckStatusAction}><input type="hidden" name="paymentId" value={p.id} /><SubmitButton size="sm" variant="secondary">Check status now</SubmitButton></form>
                    )}
                    <form action={mpesaResolveAction} className="flex items-center gap-1">
                      <input type="hidden" name="paymentId" value={p.id} /><input type="hidden" name="resolution" value="paid" />
                      <input name="receipt" placeholder="Receipt no." aria-label="M-Pesa receipt number" className={`${inputClasses} h-9 w-32 px-3 py-1 text-xs`} />
                      <SubmitButton size="sm" variant="ghost">Mark paid</SubmitButton>
                    </form>
                    <form action={mpesaResolveAction}><input type="hidden" name="paymentId" value={p.id} /><input type="hidden" name="resolution" value="not_paid" /><SubmitButton size="sm" variant="ghost">Mark not paid</SubmitButton></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="text-xs text-subtle">Verify against the M-Pesa org portal statement before resolving manually. &ldquo;Mark paid&rdquo; requires the receipt and confirms the booking through the normal once-only path, or refunds it if the tickets are gone.</p>
          {attention.manualRefunds.length > 0 && (
            <Table>
              <thead><tr><th>Refund due</th><th>Booking</th><th>Payer</th><th>Original receipt</th><th>Amount</th><th>Reason</th><th>Record reversal</th></tr></thead>
              <tbody>{attention.manualRefunds.map(({ r, reference, receipt, phone }) => (
                <tr key={r.id}>
                  <td className="text-xs">{formatDateTime(r.createdAt)}</td><td className="font-mono text-xs"><Link href={`/admin/bookings/${r.bookingId}`} className="hover:underline">{reference}</Link></td>
                  <td className="text-xs">{describePayer(phone)}</td><td className="font-mono text-xs">{receipt ?? "—"}</td><td className="tabular-nums">{formatMoney(r.amountMinor)}</td><td className="max-w-48 text-xs text-muted">{r.reason}</td>
                  <td><form action={recordManualRefundAction} className="flex items-center gap-1"><input type="hidden" name="refundId" value={r.id} /><input name="reversalReference" placeholder="Reversal ID" aria-label="Reversal transaction ID" className={`${inputClasses} h-9 w-32 px-3 py-1 text-xs`} /><SubmitButton size="sm" variant="ghost">Mark refunded</SubmitButton></form></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
          {attention.orphanCallbacks.length > 0 && (
            <Table>
              <thead><tr><th>Received</th><th>Unmatched successful callback</th><th>Receipt</th><th>Amount</th></tr></thead>
              <tbody>{attention.orphanCallbacks.map((e) => {
                const p = e.payload as { MpesaReceiptNumber?: string; Amount?: number };
                return <tr key={e.id}><td className="text-xs">{formatDateTime(e.createdAt)}</td><td className="font-mono text-xs">{e.providerReference}</td><td className="font-mono text-xs">{p.MpesaReceiptNumber ?? "—"}</td><td className="tabular-nums">{p.Amount ? formatMoney(p.Amount * 100) : "—"}</td></tr>;
              })}</tbody>
            </Table>
          )}
        </div>
      </Section>
      <Section title="Outbox jobs (pending / running / failed)">
        <Table>
          <thead><tr><th>Type</th><th>Status</th><th>Attempts</th><th>Next run</th><th>Last error</th><th /></tr></thead>
          <tbody>
            {jobRows.length === 0 ? <tr><td colSpan={6} className="text-muted">Queue is empty. All jobs succeeded.</td></tr> : jobRows.map((j) => (
              <tr key={j.id}>
                <td className="font-mono text-xs">{j.type}</td><td><StatusBadge status={j.status} /></td><td>{j.attempts}/{j.maxAttempts}</td>
                <td className="text-xs text-muted">{formatDateTime(j.runAt)}</td><td className="max-w-64 truncate text-xs text-danger">{j.lastError}</td>
                <td>{j.status === "failed" && <form action={retryJobAction}><input type="hidden" name="jobId" value={j.id} /><SubmitButton size="sm" variant="ghost">Retry</SubmitButton></form>}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
      <Section
        title={`Email problems (${mail.problems.length})`}
        action={
          <div className="flex items-center gap-3">
            {resend?.ok && <form action={checkSenderDomainAction}><SubmitButton size="sm" variant="ghost">Check sender domain</SubmitButton></form>}
            <form action={retryConfigFailuresAction}><SubmitButton size="sm" variant="ghost">Retry config failures</SubmitButton></form>
          </div>
        }
      >
        <div className="space-y-4">
          <EmailTable rows={mail.problems} empty="No failed, bounced or suppressed emails." />
          {resend?.ok && !resend.webhooks && <p className="text-xs text-subtle">Resend webhooks aren&rsquo;t configured (RESEND_WEBHOOK_SECRET), so &ldquo;Accepted&rdquo; is the last status you&rsquo;ll see unless you refresh it. Accepted means Resend took the email — not that it reached the inbox.</p>}
          {mail.unmatched > 0 && <p className="text-xs text-subtle">{mail.unmatched} Resend event{mail.unmatched === 1 ? "" : "s"} didn&rsquo;t match any delivery (e.g. emails sent from another app with the same key).</p>}
          {mail.suppressions.length > 0 && (
            <Table>
              <thead><tr><th>Suppressed address</th><th>Reason</th><th>Since</th><th /></tr></thead>
              <tbody>{mail.suppressions.map((x) => (
                <tr key={x.id}>
                  <td className="text-xs">{x.email}</td><td className="text-xs">{x.reason.replace(/_/g, " ")}<span className="block max-w-64 truncate text-muted">{x.detail}</span></td><td className="text-xs">{formatDateTime(x.createdAt)}</td>
                  <td><form action={removeSuppressionAction}><input type="hidden" name="suppressionId" value={x.id} /><SubmitButton size="sm" variant="ghost">Allow again</SubmitButton></form></td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </div>
      </Section>
      <Section title="Recent emails" action={process.env.NODE_ENV !== "production" ? <Link href="/dev/mail" className="text-sm text-muted hover:text-fg">Open dev mailbox</Link> : undefined}>
        <EmailTable rows={mail.deliveries} empty="No emails yet." />
      </Section>
      <Section title="Payment provider messages">
        <Table>
          <thead><tr><th>Received</th><th>Provider</th><th>Kind</th><th>Reference</th><th>Authenticated</th><th>Outcome</th></tr></thead>
          <tbody>{hooks.map((h) => <tr key={h.id}><td className="text-xs">{formatDateTime(h.createdAt)}</td><td>{h.provider}</td><td className="text-xs">{h.kind.replace("_", " ")}</td><td className="font-mono text-xs">{h.providerReference ?? "—"}</td><td>{h.signatureValid ? "valid" : <span className="text-danger">invalid</span>}</td><td className="text-xs">{h.outcome}</td></tr>)}</tbody>
        </Table>
      </Section>
    </div>
  );
}

function EmailTable({ rows, empty }: { rows: { e: EmailDelivery; ref: string | null }[]; empty: string }) {
  return (
    <Table>
      <thead><tr><th>Created</th><th>Kind</th><th>Booking</th><th>To</th><th>Status</th><th>Attempts</th><th>Detail</th><th>Actions</th></tr></thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={8} className="text-muted">{empty}</td></tr> : rows.map(({ e, ref }) => (
          <tr key={e.id}>
            <td className="text-xs">{formatDateTime(e.createdAt)}</td>
            <td className="text-xs">{e.kind.replace(/_/g, " ")}{e.attachmentCount > 0 && <span className="block text-muted">{e.attachmentCount} PDF</span>}</td>
            <td className="font-mono text-xs">{e.bookingId ? <Link href={`/admin/bookings/${e.bookingId}`} className="hover:underline">{ref}</Link> : "—"}</td>
            <td className="text-xs">{e.toEmail || "—"}</td>
            <td><StatusBadge status={e.status} /></td>
            <td>{e.attempts}</td>
            <td className="max-w-56 text-xs">
              {e.lastErrorCategory && <span className="block font-medium text-danger">{e.lastErrorCategory.replace(/_/g, " ")}</span>}
              {e.lastError && <span className="block truncate text-muted" title={e.lastError}>{e.lastError}</span>}
              {e.providerMessageId && e.transport === "resend" && <span className="block truncate font-mono text-subtle" title={e.providerMessageId}>{e.providerMessageId}</span>}
            </td>
            <td className="space-y-1">
              {canRetryInPlace(e) && <form action={retryEmailAction}><input type="hidden" name="deliveryId" value={e.id} /><SubmitButton size="sm" variant="secondary">Retry</SubmitButton></form>}
              {e.transport === "resend" && e.providerMessageId && <form action={refreshEmailStatusAction}><input type="hidden" name="deliveryId" value={e.id} /><SubmitButton size="sm" variant="ghost">Refresh status</SubmitButton></form>}
              {e.kind !== "account_email" && (
                <form action={resendEmailAction} className="flex items-center gap-1">
                  <input type="hidden" name="deliveryId" value={e.id} />
                  <input name="toEmail" type="email" placeholder="Same address" aria-label="Send to (optional corrected address)" className={`${inputClasses} h-9 w-40 px-3 py-1 text-xs`} />
                  <SubmitButton size="sm" variant="ghost">Send again</SubmitButton>
                </form>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

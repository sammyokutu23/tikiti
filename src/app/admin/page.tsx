import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { bookings, emailDeliveries, eventReports, events, jobs, organizerProfiles, users } from "@/db/schema";
import { FinanceBreakdown } from "@/components/dash/finance";
import { Alert, PageHeader, Section, Stat } from "@/components/ui";
import { formatAmount } from "@/lib/money";
import { financialSummary } from "@/server/ledger";
import { getCommissionBps } from "@/server/settings";
import { env } from "@/lib/env";

export const metadata = { title: "Admin" };

export default async function AdminHome() {
  const [finance, bps, pendingOrgs, openReports, failedJobs, failedEmails, userCount, liveEvents, bookingStats] = await Promise.all([
    financialSummary(),
    getCommissionBps(),
    db.$count(organizerProfiles, eq(organizerProfiles.verificationStatus, "pending")),
    db.$count(eventReports, eq(eventReports.status, "open")),
    db.$count(jobs, eq(jobs.status, "failed")),
    db.$count(emailDeliveries, eq(emailDeliveries.status, "failed")),
    db.$count(users),
    db.$count(events, eq(events.status, "published")),
    db
      .select({
        confirmed: sql<number>`count(*) filter (where ${bookings.status} = 'confirmed')::int`,
        pending: sql<number>`count(*) filter (where ${bookings.status} = 'pending')::int`,
        refundPending: sql<number>`count(*) filter (where ${bookings.paymentStatus} = 'refund_pending')::int`,
      })
      .from(bookings),
  ]);
  const b = bookingStats[0];
  return (
    <div className="space-y-8">
      <PageHeader title="Platform overview" subtitle={`M-Pesa: ${env.mpesaProvider === "daraja" ? `Daraja (${process.env.DARAJA_ENV ?? "sandbox"})` : "simulated"} · Card: ${env.cardProvider} · Email transport: ${env.emailTransport}`} />
      <div className="space-y-2">
        {pendingOrgs > 0 && <Alert tone="warning"><Link href="/admin/organizers?status=pending" className="underline">{pendingOrgs} organizer application(s)</Link> awaiting verification.</Alert>}
        {openReports > 0 && <Alert tone="warning"><Link href="/admin/events" className="underline">{openReports} open event report(s)</Link> need review.</Alert>}
        {(failedJobs > 0 || failedEmails > 0) && <Alert tone="danger"><Link href="/admin/operations" className="underline">{failedJobs} failed job(s), {failedEmails} failed email(s)</Link> — retry from Operations.</Alert>}
        {b.refundPending > 0 && <Alert tone="info">{b.refundPending} booking(s) have refunds in progress.</Alert>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net platform commission" value={formatAmount(finance.netCommissionMinor)} hint={`Current rate ${(bps / 100).toFixed(2)}%`} />
        <Stat label="Gross ticket sales" value={formatAmount(finance.grossSalesMinor)} />
        <Stat label="Confirmed bookings" value={b.confirmed} hint={`${b.pending} pending checkout`} />
        <Stat label="Live events · users" value={`${liveEvents} · ${userCount}`} />
      </div>
      <Section title="Platform ledger (all organizers)">
        <FinanceBreakdown f={finance} commissionLabel="Platform commission earned" />
      </Section>
    </div>
  );
}

import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { ledgerEntries, organizerProfiles } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Card, Input, PageHeader, Section, StatusBadge, Table } from "@/components/ui";
import { ConfirmButton } from "@/components/ui/submit-button";
import { formatAmount } from "@/lib/money";
import { getCommissionBps, MAX_COMMISSION_BPS } from "@/server/settings";
import { setCommissionAction } from "../actions";

export const metadata = { title: "Finance" };

export default async function AdminFinance({ searchParams }: PageProps<"/admin/finance">) {
  const sp = await searchParams;
  const bps = await getCommissionBps();
  const s = (t: string) => sql<number>`coalesce(sum(${ledgerEntries.amountMinor}) filter (where ${ledgerEntries.type} = ${t}), 0)::int`;
  const rows = await db
    .select({
      id: organizerProfiles.id,
      name: organizerProfiles.displayName,
      status: organizerProfiles.verificationStatus,
      gross: s("ticket_sale"),
      commission: s("platform_commission"),
      refunds: s("refund"),
      reversal: s("commission_reversal"),
      adjustments: s("adjustment"),
      balance: sql<number>`coalesce(sum(${ledgerEntries.amountMinor}), 0)::int`,
    })
    .from(organizerProfiles)
    .leftJoin(ledgerEntries, eq(ledgerEntries.organizerId, organizerProfiles.id))
    .groupBy(organizerProfiles.id)
    .orderBy(organizerProfiles.displayName);

  return (
    <div className="space-y-8">
      <PageHeader title="Finance & commission" subtitle="Ledger-derived balances. These are estimates — no money has been settled or paid out." />
      <Flash sp={sp} />
      <Card className="grid gap-6 p-5 md:grid-cols-[1fr_320px]">
        <div className="space-y-2 text-sm text-muted">
          <p className="text-base font-semibold text-fg">Platform commission: {(bps / 100).toFixed(2)}%</p>
          <p>Applied to the face value of paid tickets, rounded half-up to the cent, and snapshotted on each booking at checkout. Buyers pay face value; commission is deducted from organizer proceeds. Full refunds reverse the commission. Free tickets carry none.</p>
          <p>Changing the rate affects new bookings only.</p>
        </div>
        <form action={setCommissionAction} className="space-y-3">
          <label htmlFor="percent" className="text-sm font-medium">New rate (%)</label>
          <Input id="percent" name="percent" inputMode="decimal" defaultValue={(bps / 100).toString()} />
          <p className="text-xs text-subtle">0 – {MAX_COMMISSION_BPS / 100}%. Change is audit-logged.</p>
          <ConfirmButton message="Change the platform commission for all new bookings?">Update commission</ConfirmButton>
        </form>
      </Card>
      <Section title="Organizer balances (estimated)">
        <Table>
          <thead><tr><th>Organizer</th><th>Gross sales</th><th>Commission</th><th>Refunds</th><th>Comm. reversed</th><th>Adjustments</th><th>Est. balance owed</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name} <StatusBadge status={r.status} /></td>
                <td className="tabular-nums">{formatAmount(r.gross)}</td>
                <td className="tabular-nums">{formatAmount(r.commission)}</td>
                <td className="tabular-nums">{formatAmount(r.refunds)}</td>
                <td className="tabular-nums">{formatAmount(r.reversal)}</td>
                <td className="tabular-nums">{formatAmount(r.adjustments)}</td>
                <td className="font-semibold tabular-nums">{formatAmount(r.balance)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="text-xs text-subtle">Payouts are not automated. Settling balances requires a verified payment provider and a commercial agreement (see docs/PRODUCTION.md). Unverified or suspended organizers must not be paid out.</p>
      </Section>
    </div>
  );
}

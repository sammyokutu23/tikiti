import type { FinancialSummary } from "@/server/ledger";
import { formatAmount } from "@/lib/money";
import { Card } from "@/components/ui";

/** Keeps gross, commission, refunds and estimated proceeds clearly separate. */
export function FinanceBreakdown({ f, commissionLabel = "Platform commission" }: { f: FinancialSummary; commissionLabel?: string }) {
  const rows: [string, number, string?][] = [
    ["Gross ticket sales", f.grossSalesMinor, "Face value of confirmed paid tickets"],
    [commissionLabel, -f.commissionMinor, "Snapshotted per booking at checkout"],
    ["Refunds", -f.refundsMinor],
    ["Commission reversed on refunds", f.commissionReversedMinor],
    ...(f.adjustmentsMinor ? ([["Adjustments", f.adjustmentsMinor]] as [string, number][]) : []),
  ];
  return (
    <Card className="p-5">
      <dl className="space-y-2.5 text-sm">
        {rows.map(([label, v, hint]) => (
          <div key={label} className="flex items-start justify-between gap-4">
            <dt>
              <span className="text-fg/85">{label}</span>
              {hint && <span className="block text-xs text-subtle">{hint}</span>}
            </dt>
            <dd className="tabular-nums">{formatAmount(v)}</dd>
          </div>
        ))}
        <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
          <dt>
            <span className="font-semibold">Estimated organizer proceeds</span>
            <span className="block text-xs text-subtle">Not yet settled. Payment processing costs not known in test mode.</span>
          </dt>
          <dd className="text-lg font-bold tabular-nums">{formatAmount(f.estimatedProceedsMinor)}</dd>
        </div>
      </dl>
    </Card>
  );
}

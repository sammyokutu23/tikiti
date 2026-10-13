import { CalendarDays, MapPin } from "lucide-react";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";
import { Card } from "@/components/ui";
import { EventImage } from "./event-image";

export function OrderSummary({
  event,
  lines,
  subtotalMinor,
  feesMinor = 0,
  discountMinor = 0,
  totalMinor,
  footer,
}: {
  event: { title: string; coverImageUrl: string | null; startsAt: Date; timezone: string; venueName: string; city: string };
  lines: { name: string; quantity: number; unitPriceMinor: number }[];
  subtotalMinor: number;
  feesMinor?: number;
  discountMinor?: number;
  totalMinor: number;
  footer?: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex gap-4 border-b border-line p-4">
        <EventImage src={event.coverImageUrl} alt="" width={240} sizes="80px" className="size-20 shrink-0 rounded-2xl" />
        <div className="min-w-0 space-y-1">
          <p className="line-clamp-2 font-semibold leading-snug">{event.title}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted"><CalendarDays className="size-3.5" aria-hidden />{formatDateTime(event.startsAt, event.timezone)}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-muted"><MapPin className="size-3.5" aria-hidden />{event.venueName}, {event.city}</p>
        </div>
      </div>
      <dl className="space-y-2.5 p-4 text-sm">
        {lines.map((l) => (
          <div key={l.name} className="flex justify-between gap-4">
            <dt className="text-fg/85">{l.quantity} × {l.name}</dt>
            <dd className="tabular-nums">{formatAmount(l.unitPriceMinor * l.quantity)}</dd>
          </div>
        ))}
        <div className="flex justify-between gap-4 border-t border-line pt-2.5 text-muted">
          <dt>Subtotal</dt>
          <dd className="tabular-nums">{formatAmount(subtotalMinor)}</dd>
        </div>
        <div className="flex justify-between gap-4 text-muted">
          <dt>Booking fee</dt>
          <dd className="tabular-nums">{feesMinor ? formatAmount(feesMinor) : "KES 0"}</dd>
        </div>
        {discountMinor > 0 && (
          <div className="flex justify-between gap-4 text-success">
            <dt>Discount</dt>
            <dd className="tabular-nums">−{formatAmount(discountMinor)}</dd>
          </div>
        )}
        <div className="flex justify-between gap-4 border-t border-line pt-2.5 text-base font-bold">
          <dt>Total</dt>
          <dd className="tabular-nums">{totalMinor === 0 ? "Free" : formatMoney(totalMinor)}</dd>
        </div>
      </dl>
      {footer && <div className="border-t border-line p-4">{footer}</div>}
    </Card>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Minus, Plus, Ticket } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export type SelectorType = {
  id: string;
  name: string;
  description: string;
  priceMinor: number;
  remaining: number;
  maxPerOrder: number;
  saleState: "on_sale" | "upcoming" | "ended" | "sold_out";
  salesStartLabel?: string | null;
  salesEndLabel?: string | null;
};

const MAX_TOTAL = 20;

export function TicketSelector({ slug, types, disabledReason }: { slug: string; types: SelectorType[]; disabledReason?: string | null }) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [navigating, setNavigating] = useState(false);
  const totalQty = Object.values(qty).reduce((a, b) => a + b, 0);
  const total = useMemo(() => types.reduce((s, t) => s + (qty[t.id] ?? 0) * t.priceMinor, 0), [qty, types]);

  const set = (t: SelectorType, n: number) => {
    const others = totalQty - (qty[t.id] ?? 0);
    const max = Math.min(t.remaining, t.maxPerOrder, MAX_TOTAL - others);
    setQty((q) => ({ ...q, [t.id]: Math.max(0, Math.min(n, max)) }));
  };

  const go = () => {
    const sel = Object.entries(qty).filter(([, n]) => n > 0).map(([id, n]) => `${id}:${n}`).join(",");
    setNavigating(true);
    router.push(`/events/${slug}/checkout?t=${encodeURIComponent(sel)}`);
  };

  return (
    <div className="space-y-3">
      {types.map((t) => {
        const n = qty[t.id] ?? 0;
        const onSale = t.saleState === "on_sale" && !disabledReason;
        const others = totalQty - n;
        const canInc = onSale && n < Math.min(t.remaining, t.maxPerOrder, MAX_TOTAL - others);
        return (
          <div
            key={t.id}
            className={cn("rounded-3xl border p-4 transition", n > 0 ? "border-white/40 bg-white/[.06]" : "border-line bg-surface/70")}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold">{t.name}</p>
                <p className="mt-0.5 text-lg font-bold tabular-nums">{formatMoney(t.priceMinor)}</p>
                {t.description && <p className="mt-1 text-sm text-muted">{t.description}</p>}
                <p className="mt-1.5 text-xs text-subtle">
                  {t.saleState === "sold_out" && "Sold out"}
                  {t.saleState === "ended" && "Sales ended"}
                  {t.saleState === "upcoming" && `On sale ${t.salesStartLabel ?? "soon"}`}
                  {t.saleState === "on_sale" && (t.remaining <= 20 ? `Only ${t.remaining} left` : t.salesEndLabel ? `Sales end ${t.salesEndLabel}` : "Available")}
                </p>
              </div>
              {t.saleState === "on_sale" && !disabledReason ? (
                <div className="flex shrink-0 items-center gap-1 rounded-full bg-white/6 p-1" role="group" aria-label={`${t.name} quantity`}>
                  <button
                    type="button"
                    onClick={() => set(t, n - 1)}
                    disabled={n === 0}
                    aria-label={`Remove one ${t.name} ticket`}
                    className="flex size-9 items-center justify-center rounded-full bg-white/8 text-fg transition hover:bg-white/14 disabled:opacity-35"
                  >
                    <Minus className="size-4" aria-hidden />
                  </button>
                  <output aria-live="polite" className="w-7 text-center font-semibold tabular-nums">{n}</output>
                  <button
                    type="button"
                    onClick={() => set(t, n + 1)}
                    disabled={!canInc}
                    aria-label={`Add one ${t.name} ticket`}
                    className="flex size-9 items-center justify-center rounded-full bg-white text-black transition hover:bg-white/90 disabled:opacity-35"
                  >
                    <Plus className="size-4" aria-hidden />
                  </button>
                </div>
              ) : (
                <span className="shrink-0 rounded-full bg-white/6 px-3 py-1.5 text-xs font-medium text-muted">
                  {t.saleState === "sold_out" ? "Sold out" : t.saleState === "ended" ? "Ended" : t.saleState === "upcoming" ? "Soon" : "Unavailable"}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {disabledReason && <p className="rounded-2xl bg-white/6 p-3 text-center text-sm text-muted">{disabledReason}</p>}

      {/* Sticky action bar on mobile, inline on desktop */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/90 p-4 backdrop-blur-xl lg:static lg:border-0 lg:bg-transparent lg:p-0 lg:pt-2 lg:backdrop-blur-none">
        <div className="mx-auto flex max-w-xl items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">{totalQty > 0 ? `${totalQty} ticket${totalQty > 1 ? "s" : ""}` : "Select tickets"}</p>
            <p className="text-lg font-bold tabular-nums">{totalQty > 0 ? formatMoney(total, "KES", { compact: true }) : "—"}</p>
          </div>
          <button
            type="button"
            onClick={go}
            disabled={totalQty === 0 || navigating || !!disabledReason}
            className="inline-flex h-14 flex-[2] items-center justify-center gap-2 rounded-full bg-white px-6 font-semibold text-black transition hover:bg-white/90 disabled:opacity-40"
          >
            <Ticket className="size-5" aria-hidden />
            {navigating ? "Loading…" : total === 0 && totalQty > 0 ? "Get free tickets" : "Buy tickets"}
          </button>
        </div>
      </div>
    </div>
  );
}

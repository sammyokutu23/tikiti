import Link from "next/link";
import { BadgeCheck, MapPin, ShieldCheck } from "lucide-react";
import { CategoryBadge } from "@/components/events/category-style";
import { DateBadge } from "@/components/events/event-card";
import { EventImage } from "@/components/events/event-image";
import { formatTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { marketplaceListings } from "@/server/resale/listings";
import { resaleTotalMinor } from "@/server/resale/policy";

export const LISTING_STATUS: Record<string, [string, "neutral" | "success" | "warning" | "danger" | "info"]> = {
  pending_review: ["In review", "warning"],
  active: ["For sale", "success"],
  sold: ["Sold", "info"],
  cancelled: ["Withdrawn", "neutral"],
  rejected: ["Not approved", "danger"],
  closed: ["Closed", "neutral"],
};

export type ListingCardData = Awaited<ReturnType<typeof marketplaceListings>>[number];

/** "Verified TikoSoko ticket" or "Outside ticket · reviewed" pill. */
export function ResaleTrustBadge({ kind, className }: { kind: "platform" | "external"; className?: string }) {
  return kind === "platform" ? (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-mint px-2.5 py-1 text-xs font-semibold text-[#3a2500]", className)}>
      <BadgeCheck className="size-3.5" aria-hidden /> Verified TikoSoko ticket
    </span>
  ) : (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-sun/90 px-2.5 py-1 text-xs font-semibold text-[#2a1d00]", className)}>
      <ShieldCheck className="size-3.5" aria-hidden /> Outside ticket · reviewed
    </span>
  );
}

export function ResaleListingCard({ row }: { row: ListingCardData }) {
  const { listing, event } = row;
  return (
    <Link
      href={`/resale/${listing.reference}`}
      className="group flex overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface transition hover:-translate-y-0.5 hover:border-teal/40 hover:shadow-lg"
    >
      <div className="relative w-28 shrink-0 sm:w-36">
        <div className="absolute inset-0">
          <EventImage src={event.coverImageUrl} alt="" width={300} sizes="144px" className="size-full" />
        </div>
        <DateBadge date={event.startsAt} tz={event.timezone} className="absolute left-2 top-2 scale-90" />
      </div>
      <div className="min-w-0 flex-1 space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {!event.isExternal && <CategoryBadge category={event.category} className="!px-2 !py-0.5 !shadow-none" />}
          <ResaleTrustBadge kind={listing.kind} />
        </div>
        <h3 className="line-clamp-1 font-bold tracking-tight">{event.title}</h3>
        <p className="flex items-center gap-1.5 truncate text-sm text-muted">
          <MapPin className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{event.venueName}, {event.city} · {formatTime(event.startsAt, event.timezone)}</span>
        </p>
        <div className="flex items-end justify-between gap-2 pt-1">
          <p className="text-sm text-fg/80">{listing.ticketTypeName}</p>
          <p className="text-right">
            <span className="block text-lg font-extrabold tabular-nums">{formatMoney(resaleTotalMinor(listing.priceMinor))}</span>
            <span className="block text-[11px] text-subtle">incl. 10% fee</span>
          </p>
        </div>
      </div>
    </Link>
  );
}

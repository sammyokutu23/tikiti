import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Repeat } from "lucide-react";
import { EventDetailView } from "@/components/events/event-detail";
import { ResaleTrustBadge } from "@/components/resale/listing-card";
import { formatMoney } from "@/lib/money";
import { getPublicEvent } from "@/server/events/queries";
import { marketplaceListings } from "@/server/resale/listings";
import { resaleTotalMinor } from "@/server/resale/policy";

export async function generateMetadata({ params }: PageProps<"/events/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const d = await getPublicEvent(slug);
  return d ? { title: d.event.title, description: d.event.summary || undefined } : { title: "Event not found" };
}

export default async function EventPage({ params }: PageProps<"/events/[slug]">) {
  const { slug } = await params;
  const detail = await getPublicEvent(slug);
  if (!detail) notFound();
  const listings = detail.event.status === "published" ? await marketplaceListings({ eventId: detail.event.id, limit: 6 }) : [];
  const resale =
    listings.length > 0 ? (
      <section className="mt-4 space-y-3 rounded-[2rem] border border-line bg-surface/60 p-5" aria-labelledby="resale-h">
        <h2 id="resale-h" className="flex items-center gap-2 font-semibold">
          <Repeat className="size-4 text-teal" aria-hidden /> Fan resale ({listings.length})
        </h2>
        <ul className="space-y-2">
          {listings.map(({ listing }) => (
            <li key={listing.id}>
              <Link href={`/resale/${listing.reference}`} className="flex items-center justify-between gap-3 rounded-2xl bg-bg-elevated p-3 transition hover:ring-1 hover:ring-teal/40">
                <span className="min-w-0 space-y-1">
                  <span className="block truncate text-sm font-medium">{listing.ticketTypeName}</span>
                  <ResaleTrustBadge kind={listing.kind} className="!px-2 !py-0.5 !text-[11px]" />
                </span>
                <span className="shrink-0 text-sm font-bold tabular-nums">{formatMoney(resaleTotalMinor(listing.priceMinor))}</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-subtle">Sold by fans who can&apos;t make it. Prices include the 10% resale fee.</p>
      </section>
    ) : null;
  return <EventDetailView detail={detail} mode="public" resale={resale} />;
}

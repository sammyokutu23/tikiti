import Link from "next/link";
import { BadgeCheck, Repeat, Search, ShieldCheck, Tag, Wallet } from "lucide-react";
import { ResaleListingCard } from "@/components/resale/listing-card";
import { Spark } from "@/components/site/doodles";
import { ButtonLink, EmptyState } from "@/components/ui";
import { marketplaceListings } from "@/server/resale/listings";

export const metadata = { title: "Resale marketplace", description: "Buy and sell event tickets safely with other fans in Kenya." };

export default async function ResaleMarketplacePage({ searchParams }: PageProps<"/resale">) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.slice(0, 80) : "";
  const rows = await marketplaceListings({ q: query });

  return (
    <div className="mx-auto max-w-7xl space-y-10 px-4 pb-16 pt-6 sm:px-6 sm:pt-12">
      <section className="relative overflow-hidden rounded-[2rem] bg-[#14181b] p-6 text-white sm:p-10">
        <div className="pointer-events-none absolute -right-10 top-0 hidden h-full w-72 sm:block" aria-hidden>
          <div className="absolute inset-0 bg-[#f25f3a] [clip-path:polygon(40%_0,46%_0,26%_100%,20%_100%)]" />
          <div className="absolute inset-0 bg-[#2bb5a3] [clip-path:polygon(52%_0,58%_0,38%_100%,32%_100%)]" />
          <div className="absolute inset-0 bg-[#f7b731] [clip-path:polygon(64%_0,72%_0,52%_100%,44%_100%)]" />
        </div>
        <div className="relative max-w-2xl space-y-4">
          <p className="inline-flex items-center gap-2 font-script text-2xl font-bold text-[#f7b731]">
            <Repeat className="size-5" aria-hidden /> Can&apos;t make it? Mtu mwingine ataenda!
          </p>
          <h1 className="text-3xl font-extrabold tracking-tight sm:text-5xl">Resale marketplace</h1>
          <p className="text-white/75 sm:text-lg">
            Buy tickets from fans who can&apos;t go, or sell yours, including tickets bought on other platforms. Sellers are paid after the event, so every purchase is protected.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            <ButtonLink href="/resale/sell" size="lg">
              <Tag className="size-4" aria-hidden /> Sell a ticket
            </ButtonLink>
            <ButtonLink href="/resale/mine" size="lg" variant="outline" className="border-white/25 text-white hover:bg-white/10">
              My listings
            </ButtonLink>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: BadgeCheck, title: "TikoSoko tickets are reissued", body: "The seller's QR code is cancelled and you get a brand-new ticket in your name." },
          { icon: ShieldCheck, title: "Outside tickets are reviewed", body: "Our team checks the ticket and proof of purchase before it's listed." },
          { icon: Wallet, title: "Sellers are paid after the event", body: "If a ticket doesn't work, report it and you're refunded in full." },
        ].map(({ icon: Icon, title, body }) => (
          <div key={title} className="flex gap-3 rounded-3xl border border-line bg-surface/70 p-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-mint text-[#0b3d36]">
              <Icon className="size-5" aria-hidden />
            </span>
            <div>
              <p className="font-semibold">{title}</p>
              <p className="text-sm text-muted">{body}</p>
            </div>
          </div>
        ))}
      </section>

      <section className="space-y-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <h2 className="flex items-center gap-2 text-2xl font-extrabold">
            <Spark className="size-6 text-coral" /> Tickets for sale
          </h2>
          <form action="/resale" role="search" className="relative w-full sm:w-80">
            <label htmlFor="rq" className="sr-only">Search resale tickets</label>
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-teal" aria-hidden />
            <input id="rq" name="q" defaultValue={query} placeholder="Search event, venue, city…" className="h-12 w-full rounded-full border border-line bg-bg-elevated pl-11 pr-4 text-sm focus:border-teal/50 focus:outline-none" />
          </form>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Repeat className="size-6" />}
            title={query ? "No resale tickets match your search" : "No resale tickets right now"}
            body={query ? <>Try another search or <Link href="/resale" className="underline">see everything</Link>.</> : "Check back closer to the event. Fans list tickets when their plans change."}
            action={<ButtonLink href="/resale/sell" variant="secondary">Sell a ticket</ButtonLink>}
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {rows.map((r) => (
              <ResaleListingCard key={r.listing.id} row={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

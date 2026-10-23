import Link from "next/link";
import { ChevronRight, Ticket } from "lucide-react";
import { EventImage } from "@/components/events/event-image";
import { ButtonLink, EmptyState, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { requireUser } from "@/server/auth/guards";
import { userBookings } from "@/server/bookings/queries";

export const metadata = { title: "My purchases" };

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const user = await requireUser("/account");
  const { tab } = await searchParams;
  const scope = tab === "past" ? "past" : "upcoming";
  const rows = await userBookings(user.id, scope);

  return (
    <div className="mx-auto max-w-4xl px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <PageHeader
        title="My Purchases"
        subtitle={`Signed in as ${user.email}`}
        actions={
          <>
            <ButtonLink href="/resale/sell" variant="secondary" size="sm">Sell a ticket</ButtonLink>
            <ButtonLink href="/resale/mine" variant="ghost" size="sm">My resale listings</ButtonLink>
          </>
        }
      />
      <Tabs
        active={scope}
        items={[
          { key: "upcoming", href: "/account", label: "Upcoming" },
          { key: "past", href: "/account?tab=past", label: "Past" },
        ]}
      />
      <div className="mt-6 space-y-3">
        {rows.length === 0 ? (
          <EmptyState
            icon={<Ticket className="size-6" />}
            title={scope === "upcoming" ? "No upcoming tickets" : "No past events yet"}
            body={scope === "upcoming" ? "When you book an event, your tickets will show up here." : "Events you've attended will appear here."}
            action={scope === "upcoming" ? <ButtonLink href="/">Find tickets</ButtonLink> : undefined}
          />
        ) : (
          rows.map(({ booking, event }) => (
            <Link
              key={booking.id}
              href={`/bookings/${booking.reference}`}
              className="flex items-center gap-4 rounded-3xl border border-line bg-surface/70 p-3 transition hover:border-line-strong"
            >
              <EventImage src={event.coverImageUrl} alt="" width={240} sizes="96px" className="size-20 shrink-0 rounded-2xl sm:size-24" />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-xs text-muted">{formatDateTime(event.startsAt, event.timezone)}</p>
                <p className="line-clamp-1 font-semibold">{event.title}</p>
                <p className="truncate text-sm text-muted">{event.venueName}, {event.city}</p>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <StatusBadge status={booking.status} />
                  <span className="text-xs text-muted">{booking.reference} · {formatMoney(booking.totalMinor)}</span>
                </div>
              </div>
              <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
            </Link>
          ))
        )}
      </div>
      <p className="mt-8 text-center text-xs text-subtle">
        Booked as a guest with this email? Open the link in your confirmation email and choose “Add to my account”.
      </p>
    </div>
  );
}

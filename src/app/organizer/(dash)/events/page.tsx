import Link from "next/link";
import { CalendarPlus, CalendarX } from "lucide-react";
import { EventImage } from "@/components/events/event-image";
import { ButtonLink, EmptyState, PageHeader, StatusBadge, Badge } from "@/components/ui";
import { formatDateTime } from "@/lib/dates";
import { requireOrganizer } from "@/server/auth/guards";
import { organizerEvents } from "@/server/events/queries";

export const metadata = { title: "Your events" };

export default async function OrganizerEventsPage() {
  const { organizer } = await requireOrganizer();
  const evs = await organizerEvents(organizer.id);
  return (
    <div>
      <PageHeader title="Events" subtitle="Create, publish and manage your events." actions={<ButtonLink href="/organizer/events/new"><CalendarPlus className="size-4" aria-hidden />New event</ButtonLink>} />
      {evs.length === 0 ? (
        <EmptyState icon={<CalendarX className="size-6" />} title="No events yet" body="Start with a draft — you can preview it before publishing." action={<ButtonLink href="/organizer/events/new">Create your first event</ButtonLink>} />
      ) : (
        <ul className="space-y-3">
          {evs.map((e) => {
            const pct = e.capacity ? Math.round((e.sold / e.capacity) * 100) : 0;
            const past = e.endsAt <= new Date();
            return (
              <li key={e.id}>
                <Link href={`/organizer/events/${e.id}`} className="flex items-center gap-4 rounded-3xl border border-line bg-surface/60 p-3 hover:border-line-strong">
                  <EventImage src={e.coverImageUrl} alt="" width={240} sizes="96px" className="size-20 shrink-0 rounded-2xl" />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={e.status} />
                      {e.isHidden && <Badge tone="danger">Hidden by admin</Badge>}
                      {past && <Badge>Ended</Badge>}
                    </div>
                    <p className="truncate font-semibold">{e.title}</p>
                    <p className="text-xs text-muted">{formatDateTime(e.startsAt, e.timezone)} · {e.venueName}</p>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-fg/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Sold">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs tabular-nums text-muted">{e.sold}/{e.capacity} sold</span>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

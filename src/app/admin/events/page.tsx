import Link from "next/link";
import { asc, desc, eq, ilike, or } from "drizzle-orm";
import { Search } from "lucide-react";
import { db } from "@/db";
import { eventReports, events, organizerProfiles } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Badge, Card, Input, PageHeader, Section, StatusBadge, Table } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { adminCancelEventAction, hideEventAction, resolveReportAction } from "../actions";

export const metadata = { title: "Events & reports" };

export default async function AdminEvents({ searchParams }: PageProps<"/admin/events">) {
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.slice(0, 100) : "";
  const term = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const [rows, reports] = await Promise.all([
    db
      .select({ e: events, org: organizerProfiles.displayName, orgStatus: organizerProfiles.verificationStatus })
      .from(events)
      .innerJoin(organizerProfiles, eq(organizerProfiles.id, events.organizerId))
      .where(q ? or(ilike(events.title, term), ilike(organizerProfiles.displayName, term), ilike(events.city, term)) : undefined)
      .orderBy(asc(events.startsAt))
      .limit(200),
    db
      .select({ r: eventReports, title: events.title, slug: events.slug, eventId: events.id })
      .from(eventReports)
      .innerJoin(events, eq(events.id, eventReports.eventId))
      .where(eq(eventReports.status, "open"))
      .orderBy(desc(eventReports.createdAt)),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader title="Events & moderation" subtitle="Hide events from public view, cancel with refunds, and review reports." />
      <Flash sp={sp} />
      <Section title={`Open reports (${reports.length})`}>
        {reports.length === 0 ? (
          <p className="text-sm text-muted">No open reports. 🎉</p>
        ) : (
          <div className="space-y-3">
            {reports.map(({ r, title, slug, eventId }) => (
              <Card key={r.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <p className="font-medium"><Link href={`/events/${slug}`} className="underline-offset-4 hover:underline">{title}</Link> · <Badge tone="warning">{r.reason}</Badge></p>
                  <p className="text-muted">{r.details || "No details"} — {r.reporterEmail ?? "anonymous"}, {formatDateTime(r.createdAt)}</p>
                </div>
                <div className="flex gap-2">
                  <form action={hideEventAction}>
                    <input type="hidden" name="eventId" value={eventId} />
                    <input type="hidden" name="hidden" value="true" />
                    <input type="hidden" name="reason" value={`Reported: ${r.reason}`} />
                    <SubmitButton size="sm" variant="danger">Hide event</SubmitButton>
                  </form>
                  <form action={resolveReportAction}>
                    <input type="hidden" name="reportId" value={r.id} />
                    <SubmitButton name="status" value="resolved" size="sm" variant="secondary">Resolve</SubmitButton>
                  </form>
                  <form action={resolveReportAction}>
                    <input type="hidden" name="reportId" value={r.id} />
                    <SubmitButton name="status" value="dismissed" size="sm" variant="ghost">Dismiss</SubmitButton>
                  </form>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section title="All events">
        <form className="relative max-w-md" role="search">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <label htmlFor="eq" className="sr-only">Search events</label>
          <input id="eq" name="q" defaultValue={q} placeholder="Title, organizer or city" className="h-11 w-full rounded-full border border-line bg-fg/5 pl-11 pr-4 text-sm focus:outline-none" />
        </form>
        <Table>
          <thead><tr><th>Event</th><th>Organizer</th><th>Starts</th><th>Status</th><th>Moderation</th></tr></thead>
          <tbody>
            {rows.map(({ e, org, orgStatus }) => (
              <tr key={e.id}>
                <td className="max-w-64"><Link href={e.status === "draft" ? `/admin/bookings?event=${e.id}` : `/events/${e.slug}`} className="font-medium hover:underline">{e.title}</Link><p className="text-xs text-muted">{e.city}</p></td>
                <td>{org} <StatusBadge status={orgStatus} /></td>
                <td className="text-xs text-muted">{formatDateTime(e.startsAt, e.timezone)}</td>
                <td><StatusBadge status={e.status} /> {e.isHidden && <Badge tone="danger">Hidden</Badge>}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <form action={hideEventAction} className="flex gap-1">
                      <input type="hidden" name="eventId" value={e.id} />
                      <input type="hidden" name="hidden" value={e.isHidden ? "false" : "true"} />
                      <input type="hidden" name="back" value={`/admin/events${q ? `?q=${encodeURIComponent(q)}` : ""}`} />
                      {!e.isHidden && <Input name="reason" placeholder="Reason" className="!h-9 !w-32 !py-1 text-xs" />}
                      <SubmitButton size="sm" variant={e.isHidden ? "secondary" : "ghost"}>{e.isHidden ? "Unhide" : "Hide"}</SubmitButton>
                    </form>
                    {e.status !== "cancelled" && (
                      <form action={adminCancelEventAction}>
                        <input type="hidden" name="eventId" value={e.id} />
                        <ConfirmButton size="sm" variant="ghost" className="text-danger" message={`Cancel “${e.title}” and refund every booking?`}>Cancel</ConfirmButton>
                      </form>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Section>
    </div>
  );
}

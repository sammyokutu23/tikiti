import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { events, organizerProfiles, users } from "@/db/schema";
import { Flash } from "@/components/dash/flash";
import { Card, EmptyState, Input, PageHeader, StatusBadge, Tabs } from "@/components/ui";
import { ConfirmButton, SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatPhone } from "@/lib/utils";
import { verifyOrganizerAction } from "../actions";

export const metadata = { title: "Organizers" };

export default async function AdminOrganizers({ searchParams }: PageProps<"/admin/organizers">) {
  const sp = await searchParams;
  const status = ["pending", "verified", "rejected", "suspended"].includes(String(sp.status)) ? String(sp.status) : "all";
  const rows = await db
    .select({ o: organizerProfiles, ownerEmail: users.email, ownerName: users.name, eventCount: sql<number>`(select count(*)::int from ${events} where ${events.organizerId} = ${organizerProfiles.id})` })
    .from(organizerProfiles)
    .innerJoin(users, eq(users.id, organizerProfiles.userId))
    .where(status === "all" ? undefined : eq(organizerProfiles.verificationStatus, status as "pending"))
    .orderBy(desc(organizerProfiles.createdAt));
  const backTo = `/admin/organizers${status !== "all" ? `?status=${status}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Organizers" subtitle="Verify organizers before they can publish events or receive payouts." />
      <Flash sp={sp} />
      <Tabs active={status} items={["all", "pending", "verified", "suspended", "rejected"].map((s) => ({ key: s, label: s[0].toUpperCase() + s.slice(1), href: s === "all" ? "/admin/organizers" : `/admin/organizers?status=${s}` }))} />
      {rows.length === 0 ? (
        <EmptyState title="No organizers in this view" />
      ) : (
        <div className="space-y-3">
          {rows.map(({ o, ownerEmail, ownerName, eventCount }) => (
            <Card key={o.id} className="space-y-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <p className="flex items-center gap-2 font-semibold">{o.displayName} <StatusBadge status={o.verificationStatus} /></p>
                  <p className="text-sm text-muted">Owner: {ownerName} ({ownerEmail}) · {eventCount} event(s) · applied {formatDateTime(o.createdAt)}</p>
                  <p className="text-sm text-muted">{o.contactEmail} · {formatPhone(o.contactPhone)} · {o.city ?? "—"} {o.website && <>· <a href={o.website} target="_blank" rel="noopener noreferrer nofollow" className="underline">{o.website}</a></>}</p>
                  {o.bio && <p className="max-w-2xl text-sm text-fg/75">{o.bio}</p>}
                  {o.verificationNote && <p className="text-xs text-subtle">Note: {o.verificationNote}</p>}
                </div>
              </div>
              <form action={verifyOrganizerAction} className="flex flex-col gap-2 sm:flex-row">
                <input type="hidden" name="organizerId" value={o.id} />
                <input type="hidden" name="back" value={backTo} />
                <Input name="note" placeholder="Note (visible to the organizer)" className="sm:flex-1" />
                <div className="flex flex-wrap gap-2">
                  {o.verificationStatus !== "verified" && <SubmitButton name="status" value="verified" size="sm">Verify</SubmitButton>}
                  {o.verificationStatus === "pending" && <SubmitButton name="status" value="rejected" variant="secondary" size="sm">Reject</SubmitButton>}
                  {o.verificationStatus === "verified" && <ConfirmButton name="status" value="suspended" variant="danger" size="sm" message="Suspend this organizer? Their events disappear from public listings.">Suspend</ConfirmButton>}
                </div>
              </form>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

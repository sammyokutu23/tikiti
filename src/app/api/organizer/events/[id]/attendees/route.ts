import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { getCurrentUser, getOrganizerProfile } from "@/server/auth/session";
import { audit } from "@/server/audit";
import { attendeesCsv, attendeesForEvent } from "@/server/organizers/reports";
import { slugify } from "@/lib/utils";

/** CSV export of attendee data — owning organizer or admin only; audited (contains personal data). */
export async function GET(_req: Request, ctx: RouteContext<"/api/organizer/events/[id]/attendees">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const [ev] = await db.select().from(events).where(eq(events.id, id));
  const org = await getOrganizerProfile(user.id);
  if (!ev || (user.role !== "admin" && ev.organizerId !== org?.id)) return new Response("Not found", { status: 404 });
  const csv = attendeesCsv(await attendeesForEvent(ev.id));
  await audit(null, { actorUserId: user.id, action: "attendees.exported", entityType: "event", entityId: ev.id });
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendees-${slugify(ev.slug)}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}

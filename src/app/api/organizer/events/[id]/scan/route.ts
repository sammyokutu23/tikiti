import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser, getOrganizerProfile } from "@/server/auth/session";
import { scanTicket } from "@/server/tickets/checkin";

/**
 * Validates a scanned QR / typed code. Authorization: the event's organizer or
 * an admin. Validity is always decided from the database, never the client.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/organizer/events/[id]/scan">) {
  const { id } = await ctx.params;
  // CSRF: only accept same-origin requests.
  const origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== req.headers.get("host")) return Response.json({ error: "forbidden" }, { status: 403 });

  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const [ev] = await db.select().from(events).where(eq(events.id, id));
  const org = await getOrganizerProfile(user.id);
  if (!ev || (user.role !== "admin" && ev.organizerId !== org?.id)) return Response.json({ error: "not_found" }, { status: 404 });
  if (!rateLimit(`scan:${user.id}`, 240, 60_000).ok) return Response.json({ error: "rate_limited" }, { status: 429 });

  let raw = "";
  try {
    raw = String((await req.json())?.raw ?? "");
  } catch {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (!raw || raw.length > 500) return Response.json({ result: "invalid", message: "Invalid ticket" });
  const res = await scanTicket({ raw, eventId: ev.id, scannerUserId: user.id });
  return Response.json(res, { headers: { "Cache-Control": "no-store" } });
}

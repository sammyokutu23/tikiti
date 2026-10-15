import { eq } from "drizzle-orm";
import { db } from "@/db";
import { events } from "@/db/schema";
import { UserError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import { slugify } from "@/lib/utils";
import { getCurrentUser, getOrganizerProfile } from "@/server/auth/session";
import { parseOverlayOptions, renderBanner } from "@/server/banners/service";
import { BANNER_FORMATS, type BannerFormat } from "@/server/banners/prompt";

/**
 * Composed banner preview / download for the owning organizer (or an admin).
 * Renders on the server from stored artwork + the event row; nothing in the
 * query string is drawn on the image except on/off switches.
 *   ?g=<generationId>&i=<index>&format=landscape|square|portrait&showText=1&showDate=1…&download=1
 */
export async function GET(req: Request, ctx: RouteContext<"/api/organizer/events/[id]/banner">) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response("Not found", { status: 404 });
  const [ev] = await db.select().from(events).where(eq(events.id, id));
  const org = await getOrganizerProfile(user.id);
  if (!ev || (user.role !== "admin" && ev.organizerId !== org?.id)) return new Response("Not found", { status: 404 });
  if (!rateLimit(`banner-preview:${user.id}`, 60, 60_000).ok) return new Response("Too many requests", { status: 429 });

  const q = new URL(req.url).searchParams;
  const format = (q.get("format") ?? "landscape") as BannerFormat;
  if (!(format in BANNER_FORMATS)) return new Response("Bad format", { status: 400 });
  try {
    const bytes = await renderBanner(ev, q.get("g") ?? "", Number(q.get("i") ?? 0), format, parseOverlayOptions((k) => q.get(k)));
    const download = q.get("download") === "1";
    return new Response(Buffer.from(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        ...(download ? { "Content-Disposition": `attachment; filename="${slugify(ev.title) || "event"}-${format}.jpg"` } : {}),
      },
    });
  } catch (err) {
    if (err instanceof UserError) return new Response(err.message, { status: 404 });
    console.error("[banners] preview failed:", (err as Error).message);
    return new Response("Preview failed", { status: 500 });
  }
}

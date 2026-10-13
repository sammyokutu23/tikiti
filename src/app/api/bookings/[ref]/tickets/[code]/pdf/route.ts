import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import { authorizeBooking } from "@/server/bookings/authorize";
import { pdfResponse, renderSingleTicketPdf } from "@/server/tickets/documents";

/** One ticket as a PDF. The ticket must belong to the authorized booking. */
export async function GET(req: Request, ctx: RouteContext<"/api/bookings/[ref]/tickets/[code]/pdf">) {
  const { ref, code } = await ctx.params;
  const access = await authorizeBooking(ref, new URL(req.url).searchParams.get("access"));
  if (!access) return new Response("Not found", { status: 404 });
  const [t] = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.code, code.toUpperCase()), eq(tickets.bookingId, access.booking.id)));
  if (!t) return new Response("Not found", { status: 404 });
  try {
    const { bytes, filename } = await renderSingleTicketPdf(access.booking.id, t.id);
    return pdfResponse(bytes, filename, new URL(req.url).searchParams.get("inline") ? "inline" : "attachment");
  } catch (err) {
    console.error("[pdf] generation failed", err);
    return new Response("We couldn't generate your PDF right now. Please try again in a moment.", { status: 503 });
  }
}

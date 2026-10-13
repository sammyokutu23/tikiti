import { authorizeBooking } from "@/server/bookings/authorize";
import { pdfResponse, renderBookingPdf } from "@/server/tickets/documents";

/** All tickets of a booking as one PDF (one page per ticket). */
export async function GET(req: Request, ctx: RouteContext<"/api/bookings/[ref]/pdf">) {
  const { ref } = await ctx.params;
  const access = await authorizeBooking(ref, new URL(req.url).searchParams.get("access"));
  if (!access) return new Response("Not found", { status: 404 });
  if (access.booking.status !== "confirmed" && access.booking.status !== "refunded") {
    return new Response("Tickets are available once the booking is confirmed.", { status: 409 });
  }
  try {
    const { bytes, filename, count } = await renderBookingPdf(access.booking.id);
    if (count === 0) return new Response("No tickets found", { status: 404 });
    return pdfResponse(bytes, filename);
  } catch (err) {
    console.error("[pdf] generation failed", err);
    return new Response("We couldn't generate your PDF right now. Please try again in a moment.", { status: 503 });
  }
}

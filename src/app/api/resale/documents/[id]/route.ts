import { eq } from "drizzle-orm";
import { db } from "@/db";
import { resaleDocuments, resaleListings } from "@/db/schema";
import { getCurrentUser } from "@/server/auth/session";
import { authorizeBooking } from "@/server/bookings/authorize";

/**
 * A file uploaded with an outside resale listing. Who may download it:
 *  - admins (any file) and the seller (their own files),
 *  - the buyer, for the current ticket file only, once their resale booking is confirmed
 *    (proved with ?ref=<booking>&access=<token>, the booking cookie, or their account).
 * Everyone else gets a 404, so file ids reveal nothing.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/resale/documents/[id]">) {
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const [doc] = await db
    .select({ d: resaleDocuments, sellerUserId: resaleListings.sellerUserId, soldBookingId: resaleListings.soldBookingId })
    .from(resaleDocuments)
    .innerJoin(resaleListings, eq(resaleListings.id, resaleDocuments.listingId))
    .where(eq(resaleDocuments.id, id));
  if (!doc) return new Response("Not found", { status: 404 });

  const user = await getCurrentUser();
  let allowed = user?.role === "admin" || (!!user && user.id === doc.sellerUserId);
  // A file an admin withdrew is kept for the record; only admins can open it.
  if (!allowed && doc.d.purpose === "ticket" && doc.soldBookingId && !doc.d.withdrawnAt) {
    const params = new URL(req.url).searchParams;
    const access = await authorizeBooking(params.get("ref") ?? "", params.get("access"));
    allowed = !!access && access.booking.id === doc.soldBookingId && access.booking.status === "confirmed";
  }
  if (!allowed) return new Response("Not found", { status: 404 });

  return new Response(new Uint8Array(doc.d.data), {
    headers: {
      "Content-Type": doc.d.contentType,
      "Content-Disposition": `attachment; filename="${doc.d.filename.replace(/[^A-Za-z0-9._-]/g, "")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

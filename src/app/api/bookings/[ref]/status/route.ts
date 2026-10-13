import { authorizeBooking } from "@/server/bookings/authorize";
import { expireStaleBookings } from "@/server/bookings/lifecycle";
import { bookingPaymentView } from "@/server/bookings/payment-view";

export async function GET(req: Request, ctx: RouteContext<"/api/bookings/[ref]/status">) {
  const { ref } = await ctx.params;
  await expireStaleBookings();
  const access = await authorizeBooking(ref, new URL(req.url).searchParams.get("access"));
  if (!access) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(await bookingPaymentView(access.booking), { headers: { "Cache-Control": "no-store" } });
}

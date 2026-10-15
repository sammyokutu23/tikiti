import { authorizeBooking } from "@/server/bookings/authorize";
import { planPaymentStatus } from "@/server/plans/service";

/** Polled by the installment status page. Customer-safe fields only (no provider ids, receipts or phone numbers). */
export async function GET(req: Request, ctx: RouteContext<"/api/bookings/[ref]/plan">) {
  const { ref } = await ctx.params;
  const q = new URL(req.url).searchParams;
  const access = await authorizeBooking(ref, q.get("access"));
  if (!access) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(await planPaymentStatus(access.booking, q.get("payment") ?? ""), { headers: { "Cache-Control": "no-store" } });
}

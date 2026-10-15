"use server";

import { redirect } from "next/navigation";
import { withFlash } from "@/components/dash/flash";
import { userMessage } from "@/lib/errors";
import { formValues, type FormState } from "@/lib/forms";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { normalizeKenyanPhone } from "@/lib/utils";
import { authorizeBooking } from "@/server/bookings/authorize";
import { cancelPlanByCustomer, createPlan, startPlanPayment } from "@/server/plans/service";

/** Same caps as a full payment: each attempt pushes an M-Pesa prompt to a real phone. */
async function paymentRateLimited(ref: string, phone: string) {
  const ip = await clientIp();
  return (
    !rateLimit(`pay:${ip}`, 30, 10 * 60_000).ok ||
    !rateLimit(`pay-booking:${ref}`, 6, 10 * 60_000).ok ||
    !rateLimit(`pay-phone:${phone}`, 6, 10 * 60_000).ok
  );
}

const statusUrl = (ref: string, paymentId: string, token: string | null) =>
  `/bookings/${ref}/plan/status?payment=${paymentId}${token ? `&access=${encodeURIComponent(token)}` : ""}`;

/** Checkout: accept the plan terms, create the plan and send the deposit request. */
export async function startPlanAction(_: FormState, fd: FormData): Promise<FormState> {
  const ref = String(fd.get("reference") ?? "");
  const values = formValues(fd, ["phone", "installmentCount"]);
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) return { error: "You don't have access to this booking." };
  if (fd.get("planTerms") !== "on") return { fieldErrors: { planTerms: "Please read and accept the payment plan terms." }, values };
  const phone = normalizeKenyanPhone(values.phone ?? "");
  if (!phone) return { fieldErrors: { phone: "Enter the M-Pesa number to charge, e.g. 0712 345 678" }, values };
  if (await paymentRateLimited(ref, phone)) return { error: "Too many payment attempts. Please wait a few minutes.", values };
  let url: string;
  try {
    await createPlan({ booking: access.booking, installmentCount: Number(values.installmentCount), acceptedTerms: true });
    const res = await startPlanPayment({
      booking: access.booking,
      payerPhone: phone,
      idempotencyKey: String(fd.get("idempotencyKey") ?? ""),
      returnUrl: `/bookings/${ref}`,
    });
    url = res.redirectUrl.startsWith("/pay/mock/") ? res.redirectUrl : statusUrl(ref, res.paymentId, access.token);
  } catch (err) {
    return { error: userMessage(err), values };
  }
  redirect(url);
}

/** Booking page: pay the next installment. */
export async function payInstallmentAction(_: FormState, fd: FormData): Promise<FormState> {
  const ref = String(fd.get("reference") ?? "");
  const values = formValues(fd, ["phone"]);
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) return { error: "You don't have access to this booking." };
  const phone = normalizeKenyanPhone(values.phone ?? "");
  if (!phone) return { fieldErrors: { phone: "Enter the M-Pesa number to charge, e.g. 0712 345 678" }, values };
  if (await paymentRateLimited(ref, phone)) return { error: "Too many payment attempts. Please wait a few minutes.", values };
  let url: string;
  try {
    const res = await startPlanPayment({
      booking: access.booking,
      payerPhone: phone,
      idempotencyKey: String(fd.get("idempotencyKey") ?? ""),
      returnUrl: `/bookings/${ref}`,
    });
    url = res.redirectUrl.startsWith("/pay/mock/") ? res.redirectUrl : statusUrl(ref, res.paymentId, access.token);
  } catch (err) {
    return { error: userMessage(err), values };
  }
  redirect(url);
}

export async function cancelPlanAction(fd: FormData) {
  const ref = String(fd.get("reference") ?? "");
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) redirect("/bookings/find");
  const back = `/bookings/${ref}${access.token ? `?access=${encodeURIComponent(access.token)}` : ""}`;
  let msg: string;
  try {
    const r = await cancelPlanByCustomer(access.booking.id, access.user?.id ?? null);
    msg = r.refundMinor > 0 ? "Your plan was cancelled and a refund has been started. We'll email you when it's completed." : "Your plan was cancelled and the tickets released.";
  } catch (err) {
    redirect(withFlash(back, "error", userMessage(err)));
  }
  redirect(withFlash(back, "ok", msg));
}

"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { events } from "@/db/schema";
import { userMessage } from "@/lib/errors";
import { fieldErrors, formValues, type FormState } from "@/lib/forms";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { normalizeKenyanPhone } from "@/lib/utils";
import { getCurrentUser } from "@/server/auth/session";
import { authorizeBooking, rememberBookingAccess } from "@/server/bookings/authorize";
import { checkoutSchema, createCheckout } from "@/server/bookings/checkout";
import { cancelPendingBooking, lockBooking } from "@/server/bookings/lifecycle";
import { startPayment } from "@/server/payments/service";

export async function createCheckoutAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Please sign in to buy tickets." };
  const values = formValues(fd, ["buyerName", "buyerEmail", "buyerPhone"]);
  let items: { ticketTypeId: string; quantity: number }[] = [];
  try {
    items = JSON.parse(String(fd.get("items") ?? "[]"));
  } catch {
    return { error: "Your ticket selection is invalid. Please go back and try again.", values };
  }
  const parsed = checkoutSchema.safeParse({
    eventId: fd.get("eventId"),
    items,
    buyerName: fd.get("buyerName"),
    buyerEmail: fd.get("buyerEmail"),
    buyerPhone: fd.get("buyerPhone"),
    idempotencyKey: fd.get("idempotencyKey"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (fd.get("terms") !== "on") return { fieldErrors: { terms: "Please accept the terms and refund policy." }, values };

  const ip = await clientIp();
  if (!rateLimit(`checkout:${ip}`, 20, 10 * 60_000).ok) {
    return { error: "Too many checkout attempts. Please wait a few minutes.", values };
  }

  let ref: string;
  let free: boolean;
  try {
    const booking = await createCheckout(parsed.data, user.id);
    const [ev] = await db.select({ endsAt: events.endsAt }).from(events).where(eq(events.id, booking.eventId));
    await rememberBookingAccess(booking, ev.endsAt);
    ref = booking.reference;
    free = booking.status === "confirmed";
  } catch (err) {
    return { error: userMessage(err), values };
  }
  redirect(free ? `/bookings/${ref}?welcome=1` : `/checkout/${ref}`);
}

export async function startPaymentAction(_: FormState, fd: FormData): Promise<FormState> {
  const ref = String(fd.get("reference") ?? "");
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) return { error: "You don't have access to this booking." };
  const method = fd.get("method") === "card" ? "card" : "mpesa";
  let phone: string | null = null;
  if (method === "mpesa") {
    phone = normalizeKenyanPhone(String(fd.get("phone") ?? ""));
    if (!phone) return { fieldErrors: { phone: "Enter the M-Pesa number to charge, e.g. 0712 345 678" }, values: formValues(fd, ["phone"]) };
  }
  const ip = await clientIp();
  if (!rateLimit(`pay:${ip}`, 30, 10 * 60_000).ok) return { error: "Too many payment attempts. Please wait a moment." };
  // Each M-Pesa attempt pushes a prompt to a real phone: cap per booking and per number.
  if (!rateLimit(`pay-booking:${ref}`, 6, 10 * 60_000).ok || (phone && !rateLimit(`pay-phone:${phone}`, 6, 10 * 60_000).ok)) {
    return { error: "Too many payment attempts for this order. Please wait a few minutes before trying again." };
  }

  let url: string;
  try {
    const res = await startPayment({
      booking: access.booking,
      method,
      payerPhone: phone,
      idempotencyKey: String(fd.get("idempotencyKey") ?? ""),
      returnUrl: `/checkout/${ref}/status`,
    });
    url = res.redirectUrl;
  } catch (err) {
    return { error: userMessage(err) };
  }
  redirect(url);
}

export async function cancelCheckoutAction(fd: FormData) {
  const ref = String(fd.get("reference") ?? "");
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) redirect("/");
  const slug = await db.transaction(async (tx) => {
    const b = await lockBooking(tx, access.booking.id);
    if (b && b.status === "pending") await cancelPendingBooking(tx, b, "customer_cancelled");
    const [ev] = await tx.select({ slug: events.slug }).from(events).where(and(eq(events.id, access.booking.eventId)));
    return ev.slug;
  });
  redirect(`/events/${slug}?cancelled=1`);
}

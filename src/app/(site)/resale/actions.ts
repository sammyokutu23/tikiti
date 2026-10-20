"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { events } from "@/db/schema";
import { withFlash } from "@/components/dash/flash";
import { userMessage } from "@/lib/errors";
import { fieldErrors, formValues, safeNext, type FormState } from "@/lib/forms";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { getCurrentUser } from "@/server/auth/session";
import { authorizeBooking, rememberBookingAccess } from "@/server/bookings/authorize";
import { createResaleCheckout, resaleCheckoutSchema } from "@/server/resale/checkout";
import { readResaleUpload } from "@/server/resale/documents";
import { cancelListing, createExternalListing, createPlatformListing, externalListingSchema, platformListingSchema } from "@/server/resale/listings";
import { disputeResale } from "@/server/resale/payouts";
import { scanTicket, type ScannedTicket } from "@/server/resale/scan";

export async function createPlatformListingAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Sign in to sell a ticket." };
  const values = formValues(fd, ["ticketId", "priceKes", "payoutPhone"]);
  const parsed = platformListingSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (!rateLimit(`resale-list:${user.id}`, 20, 60 * 60_000).ok) return { error: "Too many listings in a short time. Try again later.", values };
  try {
    await createPlatformListing(parsed.data, user.id);
  } catch (err) {
    return { error: userMessage(err), values };
  }
  revalidatePath("/resale");
  redirect(withFlash("/resale/mine", "ok", "Your ticket is listed. We'll email you when it sells."));
}

export async function createExternalListingAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Sign in to sell a ticket." };
  const keys = ["eventName", "venue", "city", "startsAtLocal", "ticketTypeName", "platform", "orderRef", "note", "priceKes", "payoutPhone"];
  const values = formValues(fd, keys);
  const parsed = externalListingSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (fd.get("confirm") !== "on") return { fieldErrors: { confirm: "Please confirm the ticket is yours to sell." }, values };
  if (!rateLimit(`resale-external:${user.id}`, 10, 60 * 60_000).ok) return { error: "Too many listings in a short time. Try again later.", values };
  try {
    const ticket = await readResaleUpload(fd.get("ticketFile"), "ticket file");
    const proof = await readResaleUpload(fd.get("proofFile"), "proof of purchase");
    await createExternalListing(parsed.data, { ticket, proof }, user.id);
  } catch (err) {
    return { error: userMessage(err), values };
  }
  redirect(withFlash("/resale/mine", "ok", "Thanks! We'll review your ticket and email you once it's live (usually within a day)."));
}

export type ScanResult = { fields?: ScannedTicket; error?: string };

/** Reads the uploaded ticket and returns details for the seller to check. Nothing is saved. */
export async function scanTicketAction(fd: FormData): Promise<ScanResult> {
  const user = await getCurrentUser();
  if (!user) return { error: "Sign in to sell a ticket." };
  if (!rateLimit(`resale-scan:${user.id}`, 15, 60 * 60_000).ok) return { error: "Too many scans in a short time. Please fill in the details yourself." };
  try {
    const file = await readResaleUpload(fd.get("ticketFile"), "ticket file");
    return { fields: await scanTicket(file) };
  } catch (err) {
    return { error: userMessage(err) };
  }
}

export async function cancelListingAction(fd: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?redirect_url=/resale/mine");
  let msg: string;
  try {
    await cancelListing(String(fd.get("listingId") ?? ""), user);
    msg = "Your ticket has been withdrawn from the listings.";
  } catch (err) {
    redirect(withFlash("/resale/mine", "error", userMessage(err)));
  }
  revalidatePath("/resale");
  redirect(withFlash("/resale/mine", "ok", msg));
}

export async function createResaleCheckoutAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) return { error: "Please sign in to buy tickets." };
  const values = formValues(fd, ["buyerName", "buyerEmail", "buyerPhone"]);
  const parsed = resaleCheckoutSchema.safeParse({
    listingId: fd.get("listingId"),
    buyerName: fd.get("buyerName"),
    buyerEmail: fd.get("buyerEmail"),
    buyerPhone: fd.get("buyerPhone"),
    idempotencyKey: fd.get("idempotencyKey"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (fd.get("terms") !== "on") return { fieldErrors: { terms: "Please accept the resale terms." }, values };
  if (!rateLimit(`checkout:${await clientIp()}`, 20, 10 * 60_000).ok) return { error: "Too many checkout attempts. Please wait a few minutes.", values };

  let ref: string;
  try {
    const booking = await createResaleCheckout(parsed.data, user.id);
    const [ev] = await db.select({ endsAt: events.endsAt }).from(events).where(eq(events.id, booking.eventId));
    await rememberBookingAccess(booking, ev.endsAt);
    ref = booking.reference;
  } catch (err) {
    return { error: userMessage(err), values };
  }
  redirect(`/checkout/${ref}`);
}

export async function disputeResaleAction(fd: FormData) {
  const ref = String(fd.get("reference") ?? "");
  const access = await authorizeBooking(ref, String(fd.get("access") ?? "") || null);
  if (!access) redirect(safeNext(`/bookings/${ref}`, "/account"));
  const back = safeNext(`/bookings/${ref}${access.token ? `?access=${encodeURIComponent(access.token)}` : ""}`, "/account");
  try {
    await disputeResale(access.booking.id, String(fd.get("reason") ?? ""), access.user?.id ?? null);
  } catch (err) {
    redirect(withFlash(back, "error", userMessage(err)));
  }
  redirect(withFlash(back, "ok", "Thanks for letting us know. The seller's payment is on hold and our team will contact you."));
}

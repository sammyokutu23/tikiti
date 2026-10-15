"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { bookings, tickets } from "@/db/schema";
import { withFlash } from "@/components/dash/flash";
import { UserError, userMessage } from "@/lib/errors";
import { fieldErrors, formValues, type FormState } from "@/lib/forms";
import { rateLimit } from "@/lib/rate-limit";
import { requireOrganizer, requireOwnedEvent, requireUser } from "@/server/auth/guards";
import { cancelEvent, refundBooking, revokeTicket } from "@/server/bookings/refunds";
import {
  createEvent,
  eventFormSchema,
  LOCATION_REQUIRED_MESSAGE,
  publishEvent,
  removeTicketType,
  setInstallmentsEnabled,
  setTicketTypeActive,
  ticketTypeSchema,
  unpublishEvent,
  updateEvent,
  upsertTicketType,
} from "@/server/events/mutations";
import { applyAsOrganizer, organizerApplicationSchema } from "@/server/organizers/service";
import { saveEventImage } from "@/server/storage";
import { generateEventBanners, parseOverlayOptions, saveBannerAsCover } from "@/server/banners/service";
import { generateBannerSchema } from "@/server/banners/prompt";

const EVENT_FIELDS = ["title", "summary", "description", "category", "venueName", "venueAddress", "city", "timezone", "startsLocal", "endsLocal", "refundPolicy", "coverImageUrl",
  "latitude", "longitude", "locationConfirmed", "locationProvider", "locationPlaceId", "arrivalInstructions", "installmentsEnabled"];

export async function applyAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser("/organizer/apply");
  const values = formValues(fd, ["displayName", "contactEmail", "contactPhone", "city", "website", "bio"]);
  const parsed = organizerApplicationSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  if (!rateLimit(`apply:${user.id}`, 5, 60 * 60_000).ok) return { error: "Too many attempts. Try again later.", values };
  await applyAsOrganizer(user, parsed.data);
  redirect("/organizer");
}

export async function saveEventAction(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireOrganizer();
  const values = formValues(fd, EVENT_FIELDS);
  const id = String(fd.get("eventId") ?? "");
  // Ownership is checked before anything is parsed or saved.
  const existing = id ? await requireOwnedEvent(id, ctx) : null;
  // A pin is required for new events and for events that already have one (legacy events may lack it).
  const pinRequired = !existing || existing.latitude !== null;

  const parsed = eventFormSchema.safeParse(values);
  if (!parsed.success || (pinRequired && !parsed.data.location)) {
    const fe = parsed.success ? {} : fieldErrors(parsed.error);
    if (pinRequired && !values.latitude && !fe.location) fe.location = LOCATION_REQUIRED_MESSAGE;
    return { fieldErrors: fe, values };
  }

  // A new or changed start time must be in the future (a past start makes the event unsellable
  // and hides time-based options such as payment plans).
  const startChanged = !existing || existing.startsAt.getTime() !== parsed.data.startsAt.getTime();
  if (startChanged && parsed.data.startsAt.getTime() <= Date.now()) {
    return { fieldErrors: { startsLocal: "The start date and time is in the past. Check the date — buyers can only book future events." }, values };
  }

  let cover: string | null = values.coverImageUrl || null;
  if (cover && !cover.startsWith("/media/") && !cover.startsWith("https://")) cover = null;
  const file = fd.get("coverImage");
  if (file instanceof File && file.size > 0) {
    try {
      cover = await saveEventImage(file);
    } catch (err) {
      return { fieldErrors: { coverImage: userMessage(err) }, values };
    }
  }

  let eventId: string;
  try {
    eventId = existing
      ? (await updateEvent(existing, ctx.user, parsed.data, cover)).id
      : (await createEvent(ctx, parsed.data, cover)).id;
  } catch (err) {
    if (err instanceof UserError && err.code === "location_required") return { fieldErrors: { location: err.message }, values };
    return { error: userMessage(err), values };
  }
  revalidatePath("/", "layout");
  if (fd.get("intent") === "ai-banner") {
    redirect(withFlash(`/organizer/events/${eventId}/banner`, "ok", existing ? "Event saved. Create your banner below." : "Draft saved. Create your banner below, then add ticket types."));
  }
  redirect(withFlash(`/organizer/events/${eventId}`, "ok", existing ? "Event saved." : "Draft created. Now add ticket types."));
}

export async function publishAction(fd: FormData) {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  const back = `/organizer/events/${ev.id}`;
  try {
    if (fd.get("op") === "unpublish") await unpublishEvent(ev, ctx.user);
    else await publishEvent(ev, ctx);
  } catch (err) {
    redirect(withFlash(back, "error", userMessage(err)));
  }
  revalidatePath("/", "layout");
  redirect(withFlash(back, "ok", fd.get("op") === "unpublish" ? "Event unpublished — it's no longer visible to the public." : "Event published! It's now live."));
}

export async function saveTicketTypeAction(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  const values = formValues(fd, ["name", "description", "price", "capacity", "maxPerOrder", "salesStartLocal", "salesEndLocal"]);
  const parsed = ticketTypeSchema.safeParse({ ...values, timezone: ev.timezone });
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  try {
    await upsertTicketType(ev, ctx.user, parsed.data, String(fd.get("ticketTypeId") ?? "") || undefined);
  } catch (err) {
    return { error: userMessage(err), values };
  }
  revalidatePath(`/organizer/events/${ev.id}`);
  return { ok: true, message: "Ticket type saved.", nonce: Date.now() };
}

export async function ticketTypeOpAction(fd: FormData) {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  const id = String(fd.get("ticketTypeId"));
  const op = String(fd.get("op"));
  let msg = "Updated.";
  try {
    if (op === "remove") msg = (await removeTicketType(ev, ctx.user, id)) === "deleted" ? "Ticket type deleted." : "Ticket type has bookings, so it was deactivated instead.";
    else await setTicketTypeActive(ev, ctx.user, id, op === "activate");
  } catch (err) {
    redirect(withFlash(`/organizer/events/${ev.id}`, "error", userMessage(err)));
  }
  revalidatePath(`/organizer/events/${ev.id}`);
  redirect(withFlash(`/organizer/events/${ev.id}`, "ok", msg));
}

export async function cancelEventAction(fd: FormData) {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  const reason = String(fd.get("reason") ?? "").trim();
  const back = `/organizer/events/${ev.id}`;
  if (reason.length < 5) redirect(withFlash(back, "error", "Give buyers a short reason for the cancellation."));
  let refunded = 0;
  try {
    refunded = (await cancelEvent({ eventId: ev.id, actorUserId: ctx.user.id, reason })).refunded;
  } catch (err) {
    redirect(withFlash(back, "error", userMessage(err)));
  }
  revalidatePath("/", "layout");
  redirect(withFlash(back, "ok", `Event cancelled. ${refunded} booking(s) refunded and buyers notified.`));
}

/** Refund a booking for one of the organizer's own events. */
export async function refundBookingAction(fd: FormData) {
  const ctx = await requireOrganizer();
  const bookingId = String(fd.get("bookingId"));
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b) redirect("/organizer");
  const ev = await requireOwnedEvent(b.eventId, ctx);
  const back = String(fd.get("back") ?? `/organizer/events/${ev.id}/attendees`);
  try {
    await db.transaction((tx) =>
      refundBooking(tx, {
        bookingId,
        actorUserId: ctx.user.id,
        reason: String(fd.get("reason") ?? "Refunded by organizer").slice(0, 300) || "Refunded by organizer",
        returnInventory: true,
      }),
    );
  } catch (err) {
    redirect(withFlash(back, "error", userMessage(err)));
  }
  revalidatePath(back);
  redirect(withFlash(back, "ok", `Booking ${b.reference} refunded; tickets invalidated.`));
}

export async function revokeTicketAction(fd: FormData) {
  const ctx = await requireOrganizer();
  const ticketId = String(fd.get("ticketId"));
  const [t] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!t) redirect("/organizer");
  const ev = await requireOwnedEvent(t.eventId, ctx);
  await revokeTicket({ ticketId, actorUserId: ctx.user.id, reason: String(fd.get("reason") ?? "Revoked by organizer").slice(0, 300) || "Revoked by organizer" });
  const back = `/organizer/events/${ev.id}/tickets/${t.id}`;
  revalidatePath(back);
  redirect(withFlash(back, "ok", "Ticket revoked. It will be rejected at the gate."));
}

// ─── AI Banner Studio ────────────────────────────────────────────────────────

export async function generateBannerAction(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  const values = formValues(fd, ["style", "format", "category", "brief", "refinement", "count"]);
  const parsed = generateBannerSchema.safeParse(values);
  if (!parsed.success) return { fieldErrors: fieldErrors(parsed.error), values };
  try {
    const g = await generateEventBanners({ actor: ctx.user, event: ev, input: parsed.data });
    revalidatePath(`/organizer/events/${ev.id}/banner`);
    return { ok: true, message: `Generated ${g.imageCount} concept${g.imageCount === 1 ? "" : "s"}.`, nonce: Date.now(), values: { ...values, generationId: g.id } };
  } catch (err) {
    return { error: userMessage(err), values };
  }
}

export async function saveBannerCoverAction(_: FormState, fd: FormData): Promise<FormState> {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  if (!rateLimit(`banner-save:${ctx.user.id}`, 10, 60_000).ok) return { error: "Too many attempts. Please wait a moment." };
  try {
    await saveBannerAsCover({
      actor: ctx.user,
      event: ev,
      generationId: String(fd.get("generationId") ?? ""),
      index: Number(fd.get("index") ?? 0),
      opts: parseOverlayOptions((k) => (fd.has(k) ? String(fd.get(k)) : "0")),
      confirmReplace: fd.get("confirmReplace") === "on",
    });
  } catch (err) {
    return { error: userMessage(err) };
  }
  revalidatePath("/", "layout");
  redirect(withFlash(`/organizer/events/${ev.id}`, "ok", "New cover saved. Your previous image is kept in storage."));
}

export async function toggleInstallmentsAction(fd: FormData) {
  const ctx = await requireOrganizer();
  const ev = await requireOwnedEvent(String(fd.get("eventId")), ctx);
  const on = fd.get("op") === "on";
  try {
    await setInstallmentsEnabled(ev, ctx.user, on);
  } catch (err) {
    redirect(withFlash(`/organizer/events/${ev.id}`, "error", userMessage(err)));
  }
  revalidatePath(`/organizer/events/${ev.id}`);
  redirect(withFlash(`/organizer/events/${ev.id}`, "ok", on ? "Lipa Mdogo Mdogo is on: eligible buyers can now pay in installments." : "Lipa Mdogo Mdogo is off for new bookings. Existing plans continue."));
}

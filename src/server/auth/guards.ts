import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { db } from "@/db";
import { events, type Event, type OrganizerProfile, type User } from "@/db/schema";
import { NotFoundError } from "@/lib/errors";
import { getCurrentUser, getOrganizerProfile } from "./session";

export async function requireUser(next?: string): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect(`/sign-in${next ? `?redirect_url=${encodeURIComponent(next)}` : ""}`);
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser("/admin");
  if (user.role !== "admin") notFound(); // don't reveal the admin area exists
  return user;
}

/**
 * Organizer workspace access: requires an organizer profile that isn't rejected.
 * Pending organizers may work on drafts; publishing is checked separately.
 */
export async function requireOrganizer(): Promise<{ user: User; organizer: OrganizerProfile }> {
  const user = await requireUser("/organizer");
  const organizer = await getOrganizerProfile(user.id);
  if (!organizer) redirect("/organizer/apply");
  if (organizer.verificationStatus === "rejected") redirect("/organizer/apply");
  return { user, organizer };
}

/** Publishing/payout permission: verified profile AND organizer role granted by an admin. */
export function canPublish(user: User, organizer: OrganizerProfile) {
  return user.role !== "customer" && organizer.verificationStatus === "verified";
}

/** Loads an event the organizer owns (admins may access any). Throws 404 otherwise. */
export async function requireOwnedEvent(eventId: string, ctx: { user: User; organizer: OrganizerProfile | null }): Promise<Event> {
  if (!/^[0-9a-f-]{36}$/i.test(eventId)) throw new NotFoundError("Event not found");
  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev) throw new NotFoundError("Event not found");
  if (ctx.user.role === "admin") return ev;
  if (!ctx.organizer || ev.organizerId !== ctx.organizer.id) throw new NotFoundError("Event not found");
  return ev;
}

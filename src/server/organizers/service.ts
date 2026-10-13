import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { events, organizerProfiles, users, type User } from "@/db/schema";
import { randomCode } from "@/lib/crypto";
import { UserError } from "@/lib/errors";
import { normalizeKenyanPhone, slugify } from "@/lib/utils";
import { audit } from "../audit";
import { queueOrganizerEmail } from "../email/notify";

export const organizerApplicationSchema = z.object({
  displayName: z.string().trim().min(2, "Organizer name is required").max(80),
  contactEmail: z.email("Enter a valid email").trim().toLowerCase(),
  contactPhone: z
    .string()
    .trim()
    .transform((v, ctx) => {
      const n = normalizeKenyanPhone(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: "Enter a Kenyan phone number" });
        return z.NEVER;
      }
      return n;
    }),
  city: z.string().trim().max(60).default(""),
  website: z.union([z.url("Enter a full URL, e.g. https://…"), z.literal("")]).default(""),
  bio: z.string().trim().max(1000).default(""),
});

/**
 * Creates (or re-submits) an organizer profile in "pending" state. This does
 * NOT grant the organizer role or publishing rights — an admin must verify.
 */
export async function applyAsOrganizer(user: User, input: z.output<typeof organizerApplicationSchema>) {
  const [existing] = await db.select().from(organizerProfiles).where(eq(organizerProfiles.userId, user.id));
  if (existing && existing.verificationStatus !== "rejected") return existing;
  if (existing) {
    const [p] = await db
      .update(organizerProfiles)
      .set({ ...input, website: input.website || null, verificationStatus: "pending", verificationNote: null, updatedAt: new Date() })
      .where(eq(organizerProfiles.id, existing.id))
      .returning();
    await audit(null, { actorUserId: user.id, action: "organizer.reapplied", entityType: "organizer", entityId: p.id });
    return p;
  }
  let slug = slugify(input.displayName) || "organizer";
  const [clash] = await db.select({ id: organizerProfiles.id }).from(organizerProfiles).where(eq(organizerProfiles.slug, slug));
  if (clash) slug = `${slug}-${randomCode(4).toLowerCase()}`;
  const [p] = await db
    .insert(organizerProfiles)
    .values({ ...input, website: input.website || null, slug, userId: user.id, verificationStatus: "pending" })
    .returning();
  await audit(null, { actorUserId: user.id, action: "organizer.applied", entityType: "organizer", entityId: p.id });
  return p;
}

export async function setOrganizerVerification(
  organizerId: string,
  status: "verified" | "rejected" | "suspended" | "pending",
  admin: User,
  note: string,
) {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(organizerProfiles).where(eq(organizerProfiles.id, organizerId)).for("update");
    if (!p) throw new UserError("Organizer not found.");
    await tx
      .update(organizerProfiles)
      .set({
        verificationStatus: status,
        verificationNote: note || null,
        verifiedAt: status === "verified" ? new Date() : p.verifiedAt,
        verifiedBy: status === "verified" ? admin.id : p.verifiedBy,
        updatedAt: new Date(),
      })
      .where(eq(organizerProfiles.id, organizerId));
    // Role follows verification: only verified organizers hold the organizer role.
    const [owner] = await tx.select().from(users).where(eq(users.id, p.userId));
    if (owner.role !== "admin") {
      await tx
        .update(users)
        .set({ role: status === "verified" ? "organizer" : "customer", updatedAt: new Date() })
        .where(eq(users.id, p.userId));
    }
    await audit(tx, {
      actorUserId: admin.id,
      action: `organizer.${status}`,
      entityType: "organizer",
      entityId: organizerId,
      metadata: { note, previous: p.verificationStatus },
    });
  });
}

export async function setEventHidden(eventId: string, hidden: boolean, admin: User, reason: string) {
  const ev = await db.transaction(async (tx) => {
    const [ev] = await tx
      .update(events)
      .set({ isHidden: hidden, hiddenReason: hidden ? reason || "Hidden by moderation" : null, updatedAt: new Date() })
      .where(eq(events.id, eventId))
      .returning({ id: events.id });
    if (ev && hidden) {
      await queueOrganizerEmail(tx, eventId, "organizer_event_attention", { metadata: { reason: (reason || "Hidden by moderation").slice(0, 300) } });
    }
    return ev;
  });
  if (!ev) throw new UserError("Event not found.");
  await audit(null, {
    actorUserId: admin.id,
    action: hidden ? "event.hidden" : "event.unhidden",
    entityType: "event",
    entityId: eventId,
    metadata: { reason },
  });
}

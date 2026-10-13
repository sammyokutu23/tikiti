/**
 * Maps a Clerk identity to the local `users` row that owns roles, bookings and
 * organizer data. Rules:
 *  1. Already linked (clerk_user_id) → that user.
 *  2. Else, a local user with the same email that is not yet linked → link it,
 *     but ONLY if Clerk reports the email as verified (prevents account takeover
 *     by registering someone else's address).
 *  3. Else → create a new local *customer*. Roles are never taken from Clerk;
 *     organizer/admin are granted only by this app (verification / admin script).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, type User } from "@/db/schema";
import { isUniqueViolation } from "@/lib/errors";
import { normalizeKenyanPhone } from "@/lib/utils";
import { audit } from "../audit";

export type ClerkIdentity = {
  clerkUserId: string;
  email: string | null;
  emailVerified: boolean;
  name: string;
  phone?: string | null;
};

export async function resolveLocalUser(id: ClerkIdentity): Promise<User | null> {
  const [linked] = await db.select().from(users).where(eq(users.clerkUserId, id.clerkUserId));
  if (linked) return linked;
  if (!id.email) return null; // Clerk instance must require an email address
  const email = id.email.trim().toLowerCase();

  if (id.emailVerified) {
    const [claimed] = await db
      .update(users)
      .set({ clerkUserId: id.clerkUserId, updatedAt: new Date() })
      .where(and(sql`lower(${users.email}) = ${email}`, isNull(users.clerkUserId)))
      .returning();
    if (claimed) {
      await audit(null, { actorUserId: claimed.id, action: "user.clerk_linked", entityType: "user", entityId: claimed.id, metadata: { clerkUserId: id.clerkUserId } });
      return claimed;
    }
  } else {
    // Unverified email that matches an existing account: don't create a duplicate or link it.
    const [exists] = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
    if (exists) return null;
  }

  try {
    const [created] = await db
      .insert(users)
      .values({
        clerkUserId: id.clerkUserId,
        email,
        name: id.name.trim() || email.split("@")[0],
        phone: id.phone ? normalizeKenyanPhone(id.phone) : null,
        role: "customer",
      })
      .returning();
    await audit(null, { actorUserId: created.id, action: "user.registered", entityType: "user", entityId: created.id, metadata: { via: "clerk" } });
    return created;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Concurrent first request for the same Clerk user, or the email is owned by a
    // different (already linked) account.
    const [again] = await db.select().from(users).where(eq(users.clerkUserId, id.clerkUserId));
    return again ?? null;
  }
}

import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/db";
import { organizerProfiles, users, type User } from "@/db/schema";
import { resolveLocalUser } from "./identity";

/**
 * Current local user for this request (memoised per request). Identity comes
 * from Clerk; the local row carries role and status. Suspended users are
 * treated as signed out.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const { userId } = await auth();
  if (!userId) return null;
  let [user] = await db.select().from(users).where(eq(users.clerkUserId, userId));
  if (!user) {
    const cu = await currentUser();
    if (!cu) return null;
    const primary = cu.emailAddresses.find((e) => e.id === cu.primaryEmailAddressId) ?? cu.emailAddresses[0];
    user = (await resolveLocalUser({
      clerkUserId: userId,
      email: primary?.emailAddress ?? null,
      emailVerified: primary?.verification?.status === "verified",
      name: [cu.firstName, cu.lastName].filter(Boolean).join(" ") || cu.username || "",
      phone: cu.primaryPhoneNumber?.phoneNumber ?? null,
    }))!;
    if (!user) return null;
  }
  return user.status === "active" ? user : null;
});

export const getOrganizerProfile = cache(async (userId: string) => {
  const [p] = await db.select().from(organizerProfiles).where(eq(organizerProfiles.userId, userId));
  return p ?? null;
});

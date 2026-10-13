import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { queueEmail } from "./queue";

type ClerkEmail = {
  id: string;
  to_email_address?: string;
  subject?: string;
  body?: string;
  body_plain?: string | null;
  slug?: string | null;
  user_id?: string | null;
  delivered_by_clerk: boolean;
};

/**
 * A verified Clerk `email.created` event. Clerk keeps rendering (and owning) the
 * verification / password-reset templates; we only deliver the ones Clerk was
 * told not to deliver. Idempotent per Clerk email id.
 */
export async function handleClerkEmailEvent(e: ClerkEmail): Promise<"queued" | "duplicate" | "delivered_by_clerk" | "incomplete"> {
  if (e.delivered_by_clerk) return "delivered_by_clerk";
  if (!e.to_email_address || !e.subject || !e.body) return "incomplete";
  const local = e.user_id ? (await db.select({ id: users.id }).from(users).where(eq(users.clerkUserId, e.user_id)))[0] : undefined;
  const id = await db.transaction((tx) =>
    queueEmail(tx, {
      kind: "account_email",
      toEmail: e.to_email_address,
      userId: local?.id,
      dedupeKey: `clerk_email:${e.id}`,
      metadata: { clerkTemplate: e.slug ?? null },
      secret: JSON.stringify({ subject: e.subject, html: e.body, text: e.body_plain ?? "" }),
      maxAttempts: 3, // codes expire within minutes; don't keep retrying for an hour
    }),
  );
  return id ? "queued" : "duplicate";
}

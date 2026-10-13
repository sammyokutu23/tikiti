/**
 * Local user administration (roles are owned by this app, not Clerk).
 *
 *   npm run user:role -- <email> <customer|organizer|admin>
 *       Set a user's role. The user must have signed in via Clerk at least once.
 *
 *   npm run user:link-demo -- <your-email> <demo-email>      (dev only)
 *       Point your Clerk login at a seeded demo account (e.g. organizer@tikiti.test)
 *       so you can test as that organizer. Your own auto-created local user is unlinked.
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { users } from "@/db/schema";
import { audit } from "@/server/audit";

const [cmd, a, b] = process.argv.slice(2);
const byEmail = async (email: string) => (await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`))[0];

async function main() {
  if (cmd === "role") {
    if (!a || !["customer", "organizer", "admin"].includes(b)) throw new Error("Usage: user:role -- <email> <customer|organizer|admin>");
    const u = await byEmail(a);
    if (!u) throw new Error(`No local user with email ${a}. Sign in once via the app first.`);
    await db.update(users).set({ role: b as "admin", updatedAt: new Date() }).where(eq(users.id, u.id));
    await audit(null, { action: "user.role_set_cli", entityType: "user", entityId: u.id, metadata: { from: u.role, to: b } });
    console.log(`${u.email}: ${u.role} → ${b}`);
  } else if (cmd === "link-demo") {
    if (process.env.NODE_ENV === "production") throw new Error("dev only");
    const me = a ? await byEmail(a) : undefined;
    const demo = b ? await byEmail(b) : undefined;
    if (!me?.clerkUserId) throw new Error(`${a} has no Clerk link yet. Sign in via the app first.`);
    if (!demo) throw new Error(`No demo user ${b}`);
    await db.transaction(async (tx) => {
      await tx.update(users).set({ clerkUserId: null }).where(eq(users.id, me!.id));
      await tx.update(users).set({ clerkUserId: me!.clerkUserId }).where(eq(users.id, demo!.id));
    });
    await audit(null, { action: "user.clerk_relinked_cli", entityType: "user", entityId: demo.id, metadata: { from: me!.id } });
    console.log(`Your Clerk login (${a}) now acts as ${demo.email} [${demo.role}]. Reload the app.`);
  } else {
    console.log("Commands: role <email> <role> | link-demo <your-email> <demo-email>");
  }
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

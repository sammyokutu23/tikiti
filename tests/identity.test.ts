import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { users } from "@/db/schema";
import { resolveLocalUser } from "@/server/auth/identity";
import { makeUser, resetDb } from "./helpers";

describe("Clerk → local user mapping", () => {
  beforeEach(resetDb);

  it("creates a new customer for a first-time Clerk user", async () => {
    const u = await resolveLocalUser({ clerkUserId: "user_new1", email: "Wanjiku@Example.com", emailVerified: true, name: "Wanjiku K", phone: "+254712345678" });
    expect(u).toMatchObject({ clerkUserId: "user_new1", email: "wanjiku@example.com", role: "customer", phone: "254712345678" });
    const again = await resolveLocalUser({ clerkUserId: "user_new1", email: "wanjiku@example.com", emailVerified: true, name: "x" });
    expect(again!.id).toBe(u!.id);
  });

  it("links an existing local account by VERIFIED email and keeps its role", async () => {
    const admin = await makeUser("admin");
    const u = await resolveLocalUser({ clerkUserId: "user_adm", email: admin.email.toUpperCase(), emailVerified: true, name: "Someone" });
    expect(u!.id).toBe(admin.id);
    expect(u!.role).toBe("admin");
    expect(u!.clerkUserId).toBe("user_adm");
  });

  it("never links or duplicates on an UNVERIFIED matching email (takeover guard)", async () => {
    const admin = await makeUser("admin");
    const u = await resolveLocalUser({ clerkUserId: "user_attacker", email: admin.email, emailVerified: false, name: "Mallory" });
    expect(u).toBeNull();
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row.clerkUserId).toBeNull();
  });

  it("does not steal an email already linked to another Clerk user", async () => {
    await resolveLocalUser({ clerkUserId: "user_a", email: "shared@example.com", emailVerified: true, name: "A" });
    const b = await resolveLocalUser({ clerkUserId: "user_b", email: "shared@example.com", emailVerified: true, name: "B" });
    expect(b).toBeNull();
  });

  it("is safe under concurrent first requests", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => resolveLocalUser({ clerkUserId: "user_race", email: "race@example.com", emailVerified: true, name: "R" })),
    );
    expect(new Set(results.map((r) => r!.id)).size).toBe(1);
  });
});

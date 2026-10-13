"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { FormState } from "@/lib/forms";
import { normalizeKenyanPhone } from "@/lib/utils";
import { requireUser } from "@/server/auth/guards";

/** Local profile fields (name for tickets, phone for M-Pesa prefill). Email & password live in Clerk. */
export async function updateProfileAction(_: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const name = String(fd.get("name") ?? "").trim();
  const phoneRaw = String(fd.get("phone") ?? "").trim();
  const fe: Record<string, string> = {};
  if (name.length < 2 || name.length > 80) fe.name = "Enter your name";
  const phone = phoneRaw ? normalizeKenyanPhone(phoneRaw) : null;
  if (phoneRaw && !phone) fe.phone = "Enter a Kenyan mobile number";
  if (Object.keys(fe).length) return { fieldErrors: fe, values: { name, phone: phoneRaw } };
  await db.update(users).set({ name, phone, updatedAt: new Date() }).where(eq(users.id, user.id));
  revalidatePath("/", "layout");
  return { ok: true, message: "Profile saved." };
}

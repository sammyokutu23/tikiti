"use server";

import { db } from "@/db";
import { eventReports } from "@/db/schema";
import type { FormState } from "@/lib/forms";
import { rateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { getCurrentUser } from "@/server/auth/session";

const REASONS = ["fraud", "misleading", "inappropriate", "cancelled", "other"];

export async function reportEventAction(_: FormState, fd: FormData): Promise<FormState> {
  const reason = String(fd.get("reason") ?? "");
  if (!REASONS.includes(reason)) return { fieldErrors: { reason: "Choose a reason" } };
  const eventId = String(fd.get("eventId") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(eventId)) return { error: "Invalid event." };
  if (!rateLimit(`report:${await clientIp()}`, 5, 60 * 60_000).ok) return { error: "Too many reports. Try again later." };
  const user = await getCurrentUser();
  await db.insert(eventReports).values({
    eventId,
    reason,
    details: String(fd.get("details") ?? "").slice(0, 2000),
    reporterUserId: user?.id ?? null,
    reporterEmail: String(fd.get("email") ?? "").slice(0, 200) || user?.email || null,
  });
  return { ok: true, message: "Our team will review this event." };
}

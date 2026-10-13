/**
 * Resend delivery webhooks → email delivery status.
 *
 * - Authenticated with the endpoint's signing secret (Svix / Standard Webhooks:
 *   HMAC over id.timestamp.body, 5-minute timestamp tolerance) — see verifyResendWebhook.
 * - Idempotent: each webhook id is stored once; replays are acknowledged and ignored.
 * - Order-independent: transitions only move "forward" (accepted → delayed →
 *   delivered; bounce/complaint/failure are final), so a late "sent" can't undo
 *   "delivered".
 * - An event can arrive before the send call returned the email id; it is kept
 *   unapplied and replayed once the id is stored (applyStoredProviderEvents).
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { emailDeliveries, emailProviderEvents, emailSuppressions, type EmailDelivery } from "@/db/schema";
import { isUniqueViolation } from "@/lib/errors";
import { verifyResendWebhook } from "./resend";

const PROVIDER = "resend";

type Detail = { bounceType?: string; bounceSubType?: string; message?: string; reason?: string };
type StoredEvent = { id: string; type: string; occurredAt: Date | null; detail: unknown };

const FINAL_NEGATIVE = new Set(["bounced", "complained", "suppressed"]);

/** Returns the delivery update for one event, or null when it doesn't change anything. */
function transition(d: EmailDelivery, ev: StoredEvent): { set: Partial<EmailDelivery>; outcome: string; suppress?: "hard_bounce" | "complaint" | "provider_suppressed" } | null {
  const detail = (ev.detail ?? {}) as Detail;
  const at = ev.occurredAt ?? new Date();
  switch (ev.type) {
    case "email.sent":
      if (["queued", "sending", "retry_pending", "failed"].includes(d.status)) return { set: { status: "accepted", sentAt: d.sentAt ?? at }, outcome: "accepted" };
      return null;
    case "email.delivery_delayed":
      if (["accepted", "sending", "retry_pending", "sent"].includes(d.status)) return { set: { status: "delivery_delayed" }, outcome: "delayed" };
      return null;
    case "email.delivered":
      if (FINAL_NEGATIVE.has(d.status) || d.status === "delivered") return null;
      return { set: { status: "delivered", deliveredAt: at, lastError: null, lastErrorCategory: null }, outcome: "delivered" };
    case "email.bounced": {
      if (d.status === "complained" || d.status === "bounced") return null;
      const hard = (detail.bounceType ?? "").toLowerCase() === "permanent";
      return {
        set: { status: "bounced", lastErrorCategory: hard ? "hard_bounce" : "soft_bounce", lastError: `Bounced (${detail.bounceType ?? "unknown"}${detail.bounceSubType ? `/${detail.bounceSubType}` : ""}): ${detail.message ?? ""}`.slice(0, 1000) },
        outcome: hard ? "hard_bounce" : "soft_bounce",
        suppress: hard ? "hard_bounce" : undefined,
      };
    }
    case "email.complained":
      if (d.status === "complained") return null;
      return { set: { status: "complained", lastErrorCategory: "complaint", lastError: "Recipient marked the email as spam" }, outcome: "complained", suppress: "complaint" };
    case "email.failed":
      if (["delivered", "bounced", "complained", "failed"].includes(d.status)) return null;
      return { set: { status: "failed", lastErrorCategory: "provider_failed", lastError: `Resend could not send: ${detail.reason ?? "unknown"}`.slice(0, 1000) }, outcome: "failed" };
    case "email.suppressed":
      if (["delivered", "bounced", "complained", "suppressed"].includes(d.status)) return null;
      return {
        set: { status: "suppressed", lastErrorCategory: "suppressed", lastError: `Resend suppressed this address: ${detail.message ?? detail.reason ?? ""}`.slice(0, 1000) },
        outcome: "suppressed",
        suppress: "provider_suppressed",
      };
    default:
      return null; // opened / clicked / scheduled: not tracked
  }
}

async function applyEvent(tx: Tx, ev: StoredEvent, d: EmailDelivery): Promise<string> {
  const t = transition(d, ev);
  const lastEventAt = ev.occurredAt && (!d.lastEventAt || ev.occurredAt > d.lastEventAt) ? ev.occurredAt : d.lastEventAt;
  if (t) {
    await tx
      .update(emailDeliveries)
      .set({ ...t.set, lastEventAt, updatedAt: new Date() })
      .where(eq(emailDeliveries.id, d.id));
    Object.assign(d, t.set, { lastEventAt });
    if (t.suppress) {
      await tx
        .insert(emailSuppressions)
        .values({ email: d.toEmail, reason: t.suppress, detail: (t.set.lastError ?? "").slice(0, 300), deliveryId: d.id })
        .onConflictDoNothing();
    }
  }
  await tx
    .update(emailProviderEvents)
    .set({ deliveryId: d.id, appliedAt: new Date(), outcome: t?.outcome ?? "no_change" })
    .where(eq(emailProviderEvents.id, ev.id));
  return t?.outcome ?? "no_change";
}

function redactDetail(type: string, data: Record<string, unknown>): Detail {
  const bounce = data.bounce as { type?: string; subType?: string; message?: string } | undefined;
  const failed = data.failed as { reason?: string } | undefined;
  const suppressed = data.suppressed as { message?: string; type?: string } | undefined;
  if (type === "email.bounced" && bounce) return { bounceType: bounce.type, bounceSubType: bounce.subType, message: bounce.message?.slice(0, 300) };
  if (type === "email.failed" && failed) return { reason: failed.reason?.slice(0, 300) };
  if (type === "email.suppressed" && suppressed) return { reason: suppressed.type, message: suppressed.message?.slice(0, 300) };
  return {};
}

export type WebhookReply = { status: number; body: Record<string, unknown> };

export async function receiveResendWebhook(rawBody: string, headers: Headers): Promise<WebhookReply> {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!secret) return { status: 503, body: { error: "Resend webhooks are not configured" } };

  let payload: { type?: unknown; created_at?: unknown; data?: Record<string, unknown> };
  try {
    payload = verifyResendWebhook(rawBody, headers, secret) as typeof payload;
  } catch {
    return { status: 401, body: { error: "Invalid signature" } };
  }
  const eventId = headers.get("svix-id") ?? headers.get("webhook-id")!;
  const type = typeof payload.type === "string" ? payload.type.slice(0, 60) : "unknown";
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const emailId = typeof data.email_id === "string" ? data.email_id.slice(0, 100) : null;
  const created = typeof payload.created_at === "string" ? new Date(payload.created_at) : null;
  const occurredAt = created && !Number.isNaN(created.getTime()) ? created : null;

  return db.transaction(async (tx) => {
    let row: { id: string } | undefined;
    try {
      [row] = await tx
        .insert(emailProviderEvents)
        .values({ provider: PROVIDER, providerEventId: eventId.slice(0, 200), type, providerMessageId: emailId, occurredAt, detail: redactDetail(type, data) })
        .onConflictDoNothing()
        .returning({ id: emailProviderEvents.id });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    if (!row) return { status: 200, body: { received: true, duplicate: true } };
    if (!emailId || !type.startsWith("email.")) {
      await tx.update(emailProviderEvents).set({ appliedAt: new Date(), outcome: "ignored" }).where(eq(emailProviderEvents.id, row.id));
      return { status: 200, body: { received: true } };
    }
    const [delivery] = await tx.select().from(emailDeliveries).where(eq(emailDeliveries.providerMessageId, emailId)).for("update");
    if (!delivery) {
      await tx.update(emailProviderEvents).set({ outcome: "unmatched" }).where(eq(emailProviderEvents.id, row.id));
      return { status: 200, body: { received: true } };
    }
    const outcome = await applyEvent(tx, { id: row.id, type, occurredAt, detail: redactDetail(type, data) }, delivery);
    return { status: 200, body: { received: true, outcome } };
  });
}

/** Replays events that arrived before the send call stored the provider id. */
export async function applyStoredProviderEvents(deliveryId: string, providerMessageId: string) {
  await db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(emailProviderEvents)
      .where(and(eq(emailProviderEvents.provider, PROVIDER), eq(emailProviderEvents.providerMessageId, providerMessageId), isNull(emailProviderEvents.appliedAt)))
      .orderBy(asc(sql`coalesce(${emailProviderEvents.occurredAt}, ${emailProviderEvents.createdAt})`));
    if (pending.length === 0) return;
    const [delivery] = await tx.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId)).for("update");
    if (!delivery) return;
    for (const ev of pending) await applyEvent(tx, ev, delivery);
  });
}

/** Status reported by Resend's API (admin "refresh") mapped onto our states. */
export async function applyPolledStatus(deliveryId: string, lastEvent: string) {
  const type = `email.${lastEvent}`;
  await db.transaction(async (tx) => {
    const [delivery] = await tx.select().from(emailDeliveries).where(eq(emailDeliveries.id, deliveryId)).for("update");
    if (!delivery) return;
    const t = transition(delivery, { id: "", type, occurredAt: null, detail: {} });
    if (t) await tx.update(emailDeliveries).set({ ...t.set, updatedAt: new Date() }).where(eq(emailDeliveries.id, deliveryId));
  });
}

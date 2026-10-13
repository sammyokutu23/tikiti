/**
 * Simulated payment provider for the prototype. It behaves like a hosted
 * checkout: the customer is redirected to /pay/mock/<ref>, chooses an outcome,
 * and the "provider" sends an HMAC-signed callback to our webhook handler.
 * No card numbers or M-Pesa PINs are ever collected.
 */
import { env } from "@/lib/env";
import { hmacBase64Url, randomCode, randomToken, safeEqual } from "@/lib/crypto";
import type { ParsedWebhook, PaymentProvider } from "../types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";

export type MockOutcome = "succeeded" | "failed" | "cancelled";

export function signMockPayload(rawBody: string) {
  return hmacBase64Url(env.mockWebhookSecret, rawBody);
}

/** Builds the callback the mock provider would POST to us. */
export function buildMockCallback(args: {
  providerReference: string;
  status: MockOutcome;
  amountMinor: number;
  currency: string;
  failureReason?: string;
  eventId?: string;
}) {
  const body = JSON.stringify({
    id: args.eventId ?? `evt_${randomToken(12)}`,
    type: "payment.updated",
    data: {
      reference: args.providerReference,
      status: args.status,
      amount: args.amountMinor,
      currency: args.currency,
      failure_reason: args.failureReason ?? null,
    },
  });
  return { body, signature: signMockPayload(body) };
}

export const mockProvider: PaymentProvider = {
  name: "mock",
  isLive: false,

  async createPayment() {
    const providerReference = `MOCK-${randomCode(12)}`;
    return {
      providerReference,
      nextAction: { type: "redirect", url: `/pay/mock/${providerReference}` },
    };
  },

  async parseWebhook(rawBody, headers): Promise<ParsedWebhook> {
    let payload: unknown = null;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { valid: false, reason: "invalid_json", payload: { raw: rawBody.slice(0, 500) } };
    }
    const sig = headers.get(MOCK_SIGNATURE_HEADER) ?? "";
    if (!sig || !safeEqual(sig, signMockPayload(rawBody))) {
      return { valid: false, reason: "bad_signature", payload };
    }
    const p = payload as {
      id?: string;
      data?: { reference?: string; status?: string; amount?: number; currency?: string; failure_reason?: string | null };
    };
    const status = p.data?.status;
    if (!p.id || !p.data?.reference || !["succeeded", "failed", "cancelled"].includes(status ?? "")) {
      return { valid: false, reason: "malformed", payload };
    }
    return {
      valid: true,
      payload,
      event: {
        eventId: p.id,
        providerReference: p.data.reference,
        status: status as MockOutcome,
        amountMinor: Number(p.data.amount),
        currency: String(p.data.currency ?? "KES"),
        failureReason: p.data.failure_reason ?? undefined,
      },
    };
  },

  async refund({ refundId }) {
    if (process.env.MOCK_REFUNDS_FAIL === "true") {
      return { status: "failed", providerReference: "", failureReason: "Simulated refund failure" };
    }
    return { status: "succeeded", providerReference: `MOCKRF-${refundId.slice(0, 8).toUpperCase()}` };
  },
};

/**
 * Payment provider boundary. The app never trusts a browser redirect: only a
 * verified provider callback (webhook) moves a payment to succeeded/failed.
 *
 * Implemented:
 *  - "mock"   simulated hosted checkout + HMAC-signed webhooks (no money moves).
 *  - "daraja" Safaricom M-Pesa Express (STK Push). Its initiation, unsigned
 *             callbacks and status-query reconciliation live in ../mpesa.ts.
 * Each method ("mpesa", "card") is routed to its own provider (see registry).
 */
export type PaymentMethodKind = "mpesa" | "card";

export type CreatePaymentInput = {
  paymentId: string;
  amountMinor: number;
  currency: string;
  method: PaymentMethodKind;
  payerPhone?: string | null;
  bookingReference: string;
  description: string;
  returnUrl: string;
};

export type CreatePaymentResult = {
  providerReference: string;
  /** Where to send the customer next (hosted page / STK waiting screen). */
  nextAction: { type: "redirect"; url: string } | { type: "await_customer"; message: string };
};

export type VerifiedPaymentEvent = {
  eventId: string;
  providerReference: string;
  status: "succeeded" | "failed" | "cancelled";
  /** Null when the provider doesn't report an amount (e.g. a failure). */
  amountMinor: number | null;
  currency: string;
  failureReason?: string;
};

export type ParsedWebhook =
  | { valid: true; event: VerifiedPaymentEvent; payload: unknown }
  | { valid: false; reason: string; payload: unknown };

export interface PaymentProvider {
  readonly name: string;
  readonly isLive: boolean;
  /** Hosted-checkout style providers. Daraja is initiated via ../mpesa.ts instead. */
  createPayment?(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Verify signature/authenticity and normalise a signed webhook. */
  parseWebhook?(rawBody: string, headers: Headers): Promise<ParsedWebhook>;
  /** "manual": the provider has no automated refund; an admin must reverse it. */
  refund(input: { providerReference: string; amountMinor: number; refundId: string }): Promise<{
    status: "succeeded" | "pending" | "failed" | "manual";
    providerReference: string;
    failureReason?: string;
  }>;
}

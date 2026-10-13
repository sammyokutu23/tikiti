import type { PaymentProvider } from "../../types";
import { darajaConfigStatus } from "./config";

/**
 * Daraja provider entry for the registry. STK Push initiation, callbacks and
 * reconciliation are orchestrated in src/server/payments/mpesa.ts because they
 * need the payment row and database transactions.
 *
 * Refunds: M-Pesa Express has no refund call. Reversals use the separate
 * Reversal API (initiator credentials + async result URL), which is not
 * enabled here, so refunds are flagged for a manual reversal by an admin.
 */
export const darajaProvider: PaymentProvider = {
  name: "daraja",
  get isLive() {
    const s = darajaConfigStatus();
    return s.ok && s.env === "production";
  },
  async refund() {
    return { status: "manual", providerReference: "" };
  },
};

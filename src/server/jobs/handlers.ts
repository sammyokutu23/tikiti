import { fanOutEventUpdate } from "../email/notify";
import { sendQueuedEmail } from "../email/send";
import { processRefund } from "../payments/service";
import { handlePaymentWebhook } from "../payments/service";
import { MOCK_SIGNATURE_HEADER } from "../payments/providers/mock";
import { processMpesaCallbackEvent } from "../payments/mpesa";
import { markVerificationError, verifyExternalListing } from "../resale/verify";
import { registerJobHandler } from "./queue";

registerJobHandler("email.send", async (payload, job) => {
  await sendQueuedEmail(payload as { deliveryId: string; secret?: string }, { isLast: job.attempts >= job.maxAttempts });
});

/** One "event updated" email per confirmed booking (deduped per booking and change). */
registerJobHandler("email.event_update_fanout", async (payload) => {
  await fanOutEventUpdate(payload as { eventId: string; changeKey: string; changes: string[] });
});

registerJobHandler("refund.process", async (payload) => {
  await processRefund(String(payload.refundId));
});

/** Simulated delayed provider callback (mock provider only). */
registerJobHandler("payment.mock_webhook", async (payload) => {
  const headers = new Headers({ [MOCK_SIGNATURE_HEADER]: String(payload.signature) });
  const res = await handlePaymentWebhook("mock", String(payload.body), headers);
  if (res.status !== 200) throw new Error(`Mock webhook rejected: ${res.outcome}`);
});

/** Verifies and applies a stored M-Pesa STK callback (retried with backoff). */
registerJobHandler("payment.mpesa_callback", async (payload, job) => {
  await processMpesaCallbackEvent(String(payload.eventId), { isLast: job.attempts >= job.maxAttempts });
});

/** Verification bot for outside resale tickets (advisory; admins still approve). */
registerJobHandler("resale.verify", async (payload, job) => {
  const listingId = String(payload.listingId);
  try {
    await verifyExternalListing(listingId);
  } catch (err) {
    if (job.attempts >= job.maxAttempts) await markVerificationError(listingId, "The checks couldn't run. Use “Run checks again”, or review the ticket by hand.");
    throw err;
  }
});

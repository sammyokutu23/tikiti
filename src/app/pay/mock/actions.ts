"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { bookings, paymentTransactions } from "@/db/schema";
import { authorizeBooking } from "@/server/bookings/authorize";
import { enqueueJob } from "@/server/jobs/queue";
import { buildMockCallback, MOCK_SIGNATURE_HEADER, type MockOutcome } from "@/server/payments/providers/mock";
import { handlePaymentWebhook } from "@/server/payments/service";

/**
 * Acts as the mock provider: builds a signed callback and delivers it to the
 * same verification path a real webhook uses (immediately or after a delay).
 */
export async function simulateMockPayment(fd: FormData) {
  const providerRef = String(fd.get("providerRef") ?? "");
  const outcome = String(fd.get("outcome") ?? "") as MockOutcome;
  const delay = Math.min(Math.max(Number(fd.get("delay") ?? 0), 0), 120);
  if (!["succeeded", "failed", "cancelled"].includes(outcome)) throw new Error("Invalid outcome");

  const [row] = await db
    .select({ payment: paymentTransactions, reference: bookings.reference })
    .from(paymentTransactions)
    .innerJoin(bookings, eq(bookings.id, paymentTransactions.bookingId))
    .where(and(eq(paymentTransactions.provider, "mock"), eq(paymentTransactions.providerReference, providerRef)));
  if (!row) redirect("/");
  const access = await authorizeBooking(row.reference, String(fd.get("access") ?? "") || null);
  if (!access) redirect("/");

  const cb = buildMockCallback({
    providerReference: providerRef,
    status: outcome,
    amountMinor: row.payment.amountMinor,
    currency: row.payment.currency,
    failureReason: outcome === "failed" ? (row.payment.method === "mpesa" ? "Insufficient M-Pesa balance (simulated)" : "Card declined (simulated)") : undefined,
  });

  if (delay > 0) {
    await enqueueJob(db, "payment.mock_webhook", { body: cb.body, signature: cb.signature }, { runAt: new Date(Date.now() + delay * 1000) });
  } else {
    await handlePaymentWebhook("mock", cb.body, new Headers({ [MOCK_SIGNATURE_HEADER]: cb.signature }));
  }
  const q = access.token ? `?access=${access.token}` : "";
  redirect(`/checkout/${row.reference}/status${q}`);
}

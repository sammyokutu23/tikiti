import "dotenv/config";
import { afterAll } from "vitest";

// Tests only ever touch the dedicated test database.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.BCRYPT_COST = "4";
process.env.DB_POOL_MAX = "20";
// Tests never talk to real providers, whatever the developer's .env selects.
process.env.PAYMENT_PROVIDER = "mock";
process.env.MPESA_PROVIDER = "mock";
process.env.CARD_PROVIDER = "mock";
process.env.EMAIL_TRANSPORT = "dev-capture";
for (const k of Object.keys(process.env)) {
  if (k.startsWith("DARAJA_") || k.startsWith("RESEND_") || k === "CLERK_WEBHOOK_SIGNING_SECRET") delete process.env[k];
}

const { setEmailTransportOverride } = await import("@/server/email/transport");
const { memoryTransport } = await import("./helpers");
setEmailTransportOverride(memoryTransport);

afterAll(async () => {
  const { closeDb } = await import("@/db");
  await closeDb();
});

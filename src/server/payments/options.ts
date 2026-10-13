import { env } from "@/lib/env";
import { darajaConfigStatus } from "./providers/daraja/config";

export type MethodMode = "simulated" | "sandbox" | "live" | "unavailable";

/** What the checkout page may offer, without exposing any configuration values. */
export function checkoutPaymentModes(): { mpesa: MethodMode; card: MethodMode } {
  let mpesa: MethodMode = "unavailable";
  if (env.mpesaProvider === "mock") mpesa = "simulated";
  else if (env.mpesaProvider === "daraja") {
    const s = darajaConfigStatus();
    mpesa = s.ok ? (s.env === "production" ? "live" : "sandbox") : "unavailable";
  }
  const card: MethodMode = env.cardProvider === "mock" ? "simulated" : "unavailable";
  return { mpesa, card };
}

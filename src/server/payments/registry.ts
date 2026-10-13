import { env } from "@/lib/env";
import type { PaymentMethodKind, PaymentProvider } from "./types";
import { mockProvider } from "./providers/mock";
import { darajaProvider } from "./providers/daraja";

const providers: Record<string, PaymentProvider> = { mock: mockProvider, daraja: darajaProvider };

export function getProvider(name: string): PaymentProvider {
  const p = providers[name];
  if (!p) throw new Error(`Payment provider "${name}" is not configured`);
  return p;
}

/**
 * Each payment method has its own provider, so enabling Daraja for M-Pesa
 * leaves card payments on their existing provider.
 */
export function providerForMethod(method: PaymentMethodKind): PaymentProvider | null {
  const name = method === "mpesa" ? env.mpesaProvider : env.cardProvider;
  if (name === "disabled") return null;
  if (method === "card" && name === "daraja") throw new Error("Daraja does not process card payments; set CARD_PROVIDER");
  return getProvider(name);
}

export function availablePaymentMethods(): PaymentMethodKind[] {
  return (["mpesa", "card"] as const).filter((m) => {
    try {
      return providerForMethod(m) !== null;
    } catch {
      return false;
    }
  });
}

/**
 * Safaricom Daraja (M-Pesa Express / STK Push) configuration, read from the
 * environment at call time. Nothing here is ever sent to the browser.
 *
 * Endpoints (developer.safaricom.co.ke → Authorization, M-Pesa Express
 * Simulate, M-Pesa Express Query):
 *   OAuth   GET  {base}/oauth/v1/generate?grant_type=client_credentials
 *   STK     POST {base}/mpesa/stkpush/v1/processrequest
 *   Query   POST {base}/mpesa/stkpushquery/v1/query
 */

export const DARAJA_BASE_URLS = {
  sandbox: "https://sandbox.safaricom.co.ke",
  production: "https://api.safaricom.co.ke",
} as const;

export type DarajaEnv = keyof typeof DARAJA_BASE_URLS;
export type DarajaTransactionType = "CustomerPayBillOnline" | "CustomerBuyGoodsOnline";

/** Public sandbox test shortcode from the Daraja simulator test data. */
export const SANDBOX_SHORTCODE = "174379";

export type DarajaConfig = {
  env: DarajaEnv;
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  /** BusinessShortCode: Paybill number, or the Store/HO number for a Till. */
  shortcode: string;
  /** PartyB: the Paybill number, or the Till number for Buy Goods. */
  partyB: string;
  passkey: string;
  transactionType: DarajaTransactionType;
  /** Full callback URL sent to Safaricom, including the secret path token. */
  callbackUrl: string;
  callbackToken: string;
  timeoutMs: number;
  /** Confirm every callback with an STK status query before acting on it. */
  verifyCallbacks: boolean;
  /** Optional source-IP allowlist for callbacks (needs a trusted proxy header). */
  callbackAllowedIps: string[];
};

export class DarajaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DarajaConfigError";
  }
}

const CALLBACK_PATH = "/api/payments/stk/callback";

function bool(v: string | undefined, dflt: boolean) {
  if (v === undefined || v === "") return dflt;
  return v === "true" || v === "1";
}

/**
 * Validates and returns the Daraja configuration. Throws DarajaConfigError
 * (whose message names missing variables but never prints their values).
 */
export function darajaConfig(source: NodeJS.ProcessEnv = process.env): DarajaConfig {
  const env = (source.DARAJA_ENV ?? "sandbox") as DarajaEnv;
  if (!(env in DARAJA_BASE_URLS)) throw new DarajaConfigError(`DARAJA_ENV must be "sandbox" or "production"`);

  const missing = ["DARAJA_CONSUMER_KEY", "DARAJA_CONSUMER_SECRET", "DARAJA_SHORTCODE", "DARAJA_PASSKEY", "DARAJA_CALLBACK_URL", "DARAJA_CALLBACK_TOKEN"].filter(
    (k) => !source[k]?.trim(),
  );
  if (missing.length) throw new DarajaConfigError(`Missing M-Pesa configuration: ${missing.join(", ")}`);

  const transactionType = (source.DARAJA_TRANSACTION_TYPE || "CustomerPayBillOnline") as DarajaTransactionType;
  if (transactionType !== "CustomerPayBillOnline" && transactionType !== "CustomerBuyGoodsOnline") {
    throw new DarajaConfigError("DARAJA_TRANSACTION_TYPE must be CustomerPayBillOnline or CustomerBuyGoodsOnline");
  }
  const shortcode = source.DARAJA_SHORTCODE!.trim();
  const partyB = (source.DARAJA_PARTY_B || shortcode).trim();
  if (!/^\d{5,8}$/.test(shortcode) || !/^\d{5,8}$/.test(partyB)) {
    throw new DarajaConfigError("DARAJA_SHORTCODE / DARAJA_PARTY_B must be 5–8 digit M-Pesa shortcodes");
  }

  const callbackToken = source.DARAJA_CALLBACK_TOKEN!.trim();
  if (callbackToken.length < 24 || !/^[A-Za-z0-9_-]+$/.test(callbackToken)) {
    throw new DarajaConfigError("DARAJA_CALLBACK_TOKEN must be ≥24 URL-safe characters (openssl rand -hex 24)");
  }
  let callbackBase: URL;
  try {
    callbackBase = new URL(source.DARAJA_CALLBACK_URL!.trim());
  } catch {
    throw new DarajaConfigError("DARAJA_CALLBACK_URL is not a valid URL");
  }
  if (!callbackBase.pathname.replace(/\/$/, "").endsWith(CALLBACK_PATH)) {
    throw new DarajaConfigError(`DARAJA_CALLBACK_URL must point at ${CALLBACK_PATH} on your public domain`);
  }
  if (callbackBase.protocol !== "https:") {
    throw new DarajaConfigError("DARAJA_CALLBACK_URL must use HTTPS and be publicly reachable by Safaricom");
  }

  if (env === "production") {
    // Never go live by accident: production needs an explicit, separate switch.
    if (!bool(source.DARAJA_LIVE_PAYMENTS_ENABLED, false)) {
      throw new DarajaConfigError("DARAJA_ENV=production requires DARAJA_LIVE_PAYMENTS_ENABLED=true");
    }
    if (shortcode === SANDBOX_SHORTCODE) {
      throw new DarajaConfigError("The sandbox test shortcode cannot be used with DARAJA_ENV=production");
    }
  }

  const timeoutMs = Number(source.DARAJA_TIMEOUT_MS || 15_000);
  return {
    env,
    baseUrl: DARAJA_BASE_URLS[env],
    consumerKey: source.DARAJA_CONSUMER_KEY!.trim(),
    consumerSecret: source.DARAJA_CONSUMER_SECRET!.trim(),
    shortcode,
    partyB,
    passkey: source.DARAJA_PASSKEY!.trim(),
    transactionType,
    callbackUrl: `${callbackBase.origin}${CALLBACK_PATH}/${callbackToken}`,
    callbackToken,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? Math.min(timeoutMs, 60_000) : 15_000,
    verifyCallbacks: bool(source.DARAJA_VERIFY_CALLBACKS, true),
    callbackAllowedIps: (source.DARAJA_CALLBACK_ALLOWED_IPS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** True when Daraja has enough configuration to be used (without throwing). */
export function darajaConfigStatus(): { ok: true; env: DarajaEnv } | { ok: false; error: string } {
  try {
    return { ok: true, env: darajaConfig().env };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Minimal Daraja HTTP client: OAuth token, STK Push, STK Push Query.
 *
 * Outcomes are classified so callers never guess about money:
 *  - "accepted"  → Safaricom accepted the STK request (prompt sent).
 *  - DarajaRejectedError  → definitively NOT processed (safe to retry later).
 *  - DarajaUncertainError → request may have reached M-Pesa (timeout, garbled
 *    reply). Callers must reconcile before ever sending another prompt.
 * Secrets, tokens and passwords are never included in errors or logs.
 */
import type { DarajaConfig } from "./config";

export class DarajaRejectedError extends Error {
  constructor(
    message: string,
    public code: string,
    public httpStatus: number | null,
    /** True when Safaricom asked us to slow down / try later. */
    public busy = false,
  ) {
    super(message);
    this.name = "DarajaRejectedError";
  }
}

export class DarajaAuthError extends DarajaRejectedError {
  constructor(message: string, httpStatus: number | null) {
    super(message, "auth_failed", httpStatus);
    this.name = "DarajaAuthError";
  }
}

export class DarajaUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DarajaUncertainError";
  }
}

/** Daraja timestamps are East Africa Time (UTC+3, no DST): YYYYMMDDHHmmss. */
export function darajaTimestamp(d = new Date()): string {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().replace(/[-T:]/g, "").slice(0, 14);
}

/** Password = base64(Shortcode + Passkey + Timestamp). */
export function stkPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");
}

// ─── HTTP plumbing ───────────────────────────────────────────────────────────

type RawResponse = { status: number; json: Record<string, unknown> | null; text: string };

/** Network failures where the request certainly never left this machine. */
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<RawResponse> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    if (e.cause?.code && NOT_SENT_CODES.has(e.cause.code)) {
      throw new DarajaRejectedError("M-Pesa could not be reached", `network_${e.cause.code}`, null, true);
    }
    if (e.name === "TimeoutError" || e.name === "AbortError") throw new DarajaUncertainError("Daraja request timed out");
    throw new DarajaUncertainError(`Daraja network error: ${e.name ?? "unknown"}`);
  }
  const text = await res.text().catch(() => "");
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

function errorFields(json: Record<string, unknown> | null) {
  return {
    code: typeof json?.errorCode === "string" ? json.errorCode : null,
    message: typeof json?.errorMessage === "string" ? json.errorMessage.slice(0, 300) : null,
  };
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

type CachedToken = { key: string; token: string; expiresAt: number };
const g = globalThis as unknown as { __darajaToken?: CachedToken | null; __darajaTokenInflight?: Promise<string> | null };

export function resetDarajaTokenCache() {
  g.__darajaToken = null;
  g.__darajaTokenInflight = null;
}

/**
 * Access tokens last ~1h. Cached per (environment, consumer key) and refreshed
 * 60s early. Concurrent callers share one in-flight request, because Daraja
 * may invalidate the previous token whenever a new one is generated.
 */
export async function getAccessToken(cfg: DarajaConfig, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const key = `${cfg.env}:${cfg.consumerKey}`;
  const cached = g.__darajaToken;
  if (!opts.forceRefresh && cached && cached.key === key && cached.expiresAt > Date.now()) return cached.token;
  if (g.__darajaTokenInflight) return g.__darajaTokenInflight;

  g.__darajaTokenInflight = (async () => {
    const basic = Buffer.from(`${cfg.consumerKey}:${cfg.consumerSecret}`).toString("base64");
    let res: RawResponse;
    try {
      res = await request(`${cfg.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, { method: "GET", headers: { Authorization: `Basic ${basic}` } }, cfg.timeoutMs);
    } catch (err) {
      // No payment request has been sent yet, so any failure here is definitive.
      throw new DarajaAuthError(`M-Pesa authentication unavailable (${(err as Error).name})`, null);
    }
    const token = res.json?.access_token;
    if (res.status !== 200 || typeof token !== "string" || !token) {
      const { code } = errorFields(res.json);
      throw new DarajaAuthError(`M-Pesa authentication failed (HTTP ${res.status}${code ? `, ${code}` : ""})`, res.status);
    }
    const ttl = Number(res.json?.expires_in ?? 3599);
    g.__darajaToken = { key, token, expiresAt: Date.now() + Math.max(60, (Number.isFinite(ttl) ? ttl : 3599) - 60) * 1000 };
    return token;
  })();
  try {
    return await g.__darajaTokenInflight;
  } finally {
    g.__darajaTokenInflight = null;
  }
}

function isInvalidToken(res: RawResponse) {
  const { code } = errorFields(res.json);
  return res.status === 401 || code === "404.001.03";
}

/** POST with a bearer token; on an invalid-token rejection, refresh once and retry. */
async function authedPost(cfg: DarajaConfig, path: string, body: unknown): Promise<RawResponse> {
  const send = async (token: string) =>
    request(`${cfg.baseUrl}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, cfg.timeoutMs);
  let res = await send(await getAccessToken(cfg));
  // An invalid-token reply means the request was rejected before processing, so a retry can't double-charge.
  if (isInvalidToken(res)) res = await send(await getAccessToken(cfg, { forceRefresh: true }));
  if (isInvalidToken(res)) throw new DarajaAuthError("M-Pesa rejected the access token", res.status);
  return res;
}

// ─── STK Push ────────────────────────────────────────────────────────────────

export type StkPushInput = {
  /** Whole Kenyan shillings. */
  amountKes: number;
  /** 2547XXXXXXXX / 2541XXXXXXXX */
  phone: string;
  /** Shown to the customer in the prompt; max 12 alphanumeric chars. */
  accountReference: string;
  /** Max 13 chars. */
  description: string;
};

export type StkPushAccepted = {
  merchantRequestId: string;
  checkoutRequestId: string;
  responseDescription: string;
  customerMessage: string;
};

const BUSY_CODES = new Set(["500.003.02", "500.003.03"]);

export async function stkPush(cfg: DarajaConfig, input: StkPushInput): Promise<StkPushAccepted> {
  if (!Number.isInteger(input.amountKes) || input.amountKes < 1) throw new Error("STK amount must be a positive whole number of KES");
  if (!/^254[17]\d{8}$/.test(input.phone)) throw new Error("STK phone must be in 2547XXXXXXXX format");
  const timestamp = darajaTimestamp();
  const body = {
    BusinessShortCode: cfg.shortcode,
    Password: stkPassword(cfg.shortcode, cfg.passkey, timestamp),
    Timestamp: timestamp,
    TransactionType: cfg.transactionType,
    Amount: input.amountKes,
    PartyA: input.phone,
    PartyB: cfg.partyB,
    PhoneNumber: input.phone,
    CallBackURL: cfg.callbackUrl,
    AccountReference: input.accountReference.replace(/[^A-Za-z0-9]/g, "").slice(0, 12),
    TransactionDesc: input.description.slice(0, 13),
  };
  const res = await authedPost(cfg, "/mpesa/stkpush/v1/processrequest", body);
  const j = res.json;

  if (res.status === 200 && j && String(j.ResponseCode) === "0") {
    const merchantRequestId = j.MerchantRequestID;
    const checkoutRequestId = j.CheckoutRequestID;
    if (typeof checkoutRequestId !== "string" || !checkoutRequestId || typeof merchantRequestId !== "string") {
      // "Accepted" without identifiers: a prompt may be on its way, but we can't track it.
      throw new DarajaUncertainError("Daraja accepted the request without a CheckoutRequestID");
    }
    return {
      merchantRequestId,
      checkoutRequestId,
      responseDescription: String(j.ResponseDescription ?? ""),
      customerMessage: String(j.CustomerMessage ?? ""),
    };
  }
  if (res.status === 200 && j && j.ResponseCode !== undefined) {
    throw new DarajaRejectedError(String(j.ResponseDescription ?? "STK request rejected").slice(0, 300), `response_${j.ResponseCode}`, 200);
  }
  const { code, message } = errorFields(j);
  if (code) {
    // Structured Daraja error: the request was validated and refused.
    throw new DarajaRejectedError(message ?? "STK request rejected", code, res.status, res.status === 429 || BUSY_CODES.has(code));
  }
  if (res.status === 429) throw new DarajaRejectedError("Too many requests to M-Pesa", "http_429", 429, true);
  if (res.status >= 400 && res.status < 500) throw new DarajaRejectedError(`STK request rejected (HTTP ${res.status})`, `http_${res.status}`, res.status);
  // 5xx without a Daraja error body, or a 200 we can't read: outcome unknown.
  throw new DarajaUncertainError(`Unreadable Daraja response (HTTP ${res.status})`);
}

// ─── STK Push Query ──────────────────────────────────────────────────────────

export type StkQueryResult =
  | { state: "final"; resultCode: string; resultDesc: string; merchantRequestId: string | null }
  /** M-Pesa hasn't finished (customer still on the prompt). */
  | { state: "processing"; detail: string }
  /** Couldn't get an answer (timeout, outage, rate limit, unknown error). */
  | { state: "unavailable"; detail: string };

export async function stkQuery(cfg: DarajaConfig, checkoutRequestId: string): Promise<StkQueryResult> {
  const timestamp = darajaTimestamp();
  let res: RawResponse;
  try {
    res = await authedPost(cfg, "/mpesa/stkpushquery/v1/query", {
      BusinessShortCode: cfg.shortcode,
      Password: stkPassword(cfg.shortcode, cfg.passkey, timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    });
  } catch (err) {
    return { state: "unavailable", detail: (err as Error).message.slice(0, 200) };
  }
  const j = res.json;
  if (res.status === 200 && j && String(j.ResponseCode) === "0" && j.ResultCode !== undefined && j.ResultCode !== null && j.ResultCode !== "") {
    if (typeof j.CheckoutRequestID === "string" && j.CheckoutRequestID !== checkoutRequestId) {
      return { state: "unavailable", detail: "Query answered for a different CheckoutRequestID" };
    }
    // 4999: "The transaction is still under processing" — not a final answer.
    if (String(j.ResultCode) === "4999") return { state: "processing", detail: String(j.ResultDesc ?? "still processing").slice(0, 200) };
    return {
      state: "final",
      resultCode: String(j.ResultCode),
      resultDesc: String(j.ResultDesc ?? "").slice(0, 300),
      merchantRequestId: typeof j.MerchantRequestID === "string" ? j.MerchantRequestID : null,
    };
  }
  const { code, message } = errorFields(j);
  if (message && /being processed|in process|pending/i.test(message)) return { state: "processing", detail: message };
  return { state: "unavailable", detail: `HTTP ${res.status}${code ? ` ${code}` : ""}${message ? `: ${message}` : ""}`.slice(0, 200) };
}

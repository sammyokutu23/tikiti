/**
 * Resend adapter (https://resend.com/docs/api-reference/emails/send-email).
 *
 * Server-only: the API key is read from the environment at send time and never
 * leaves this module. Every send carries an Idempotency-Key derived from the
 * internal delivery id, so retrying after a timeout or 5xx cannot produce a
 * second email (Resend honours the key for 24 hours).
 *
 * Failures are classified so the delivery worker knows what to do:
 *  - retryable + uncertain  → timeout / network / 5xx: retry with the SAME key.
 *  - retryable              → rate limit, quota, concurrent request: retry later.
 *  - not retryable          → bad key, unverified sender, invalid recipient,
 *                             idempotency conflict: stop and surface to admins.
 */
import { Resend } from "resend";

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailConfigError";
  }
}

export type EmailErrorCategory =
  | "config"
  | "invalid_recipient"
  | "rejected"
  | "rate_limited"
  | "quota"
  | "provider_unavailable"
  | "uncertain"
  | "idempotency_conflict"
  | "attachment"
  | "render";

export class EmailSendError extends Error {
  readonly retryable: boolean;
  readonly uncertain: boolean;
  readonly retryAfterMs: number | null;
  readonly providerCode: string | null;
  constructor(
    message: string,
    public category: EmailErrorCategory,
    opts: { retryable: boolean; uncertain?: boolean; retryAfterMs?: number | null; providerCode?: string | null } = { retryable: false },
  ) {
    super(message);
    this.name = "EmailSendError";
    this.retryable = opts.retryable;
    this.uncertain = opts.uncertain ?? false;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.providerCode = opts.providerCode ?? null;
  }
}

export type ResendConfig = {
  apiKey: string;
  from: string;
  fromEmail: string;
  replyTo: string;
  timeoutMs: number;
  webhookSecret: string | null;
  /** onboarding@resend.dev style sender: Resend only delivers to the account owner's address. */
  testSender: boolean;
};

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
export const isEmailAddress = (s: string | null | undefined): s is string => !!s && s.length <= 254 && EMAIL_RE.test(s);

export function resendConfig(source: NodeJS.ProcessEnv = process.env): ResendConfig {
  const missing = ["RESEND_API_KEY", "RESEND_FROM_EMAIL"].filter((k) => !source[k]?.trim());
  if (missing.length) throw new EmailConfigError(`Missing Resend configuration: ${missing.join(", ")}`);
  const apiKey = source.RESEND_API_KEY!.trim();
  if (!/^re_[A-Za-z0-9_]{8,}$/.test(apiKey)) throw new EmailConfigError("RESEND_API_KEY doesn't look like a Resend key (re_…)");
  const fromEmail = source.RESEND_FROM_EMAIL!.trim();
  if (!isEmailAddress(fromEmail)) throw new EmailConfigError("RESEND_FROM_EMAIL must be a plain address, e.g. tickets@yourdomain.co.ke");
  const replyTo = source.RESEND_REPLY_TO?.trim() || source.SUPPORT_EMAIL?.trim() || "";
  if (replyTo && !isEmailAddress(replyTo)) throw new EmailConfigError("RESEND_REPLY_TO must be a plain email address");
  const webhookSecret = source.RESEND_WEBHOOK_SECRET?.trim() || null;
  if (webhookSecret && !webhookSecret.startsWith("whsec_")) throw new EmailConfigError("RESEND_WEBHOOK_SECRET must be the whsec_… signing secret from the Resend webhook page");
  const base = source.APP_BASE_URL || source.APP_URL || "";
  if (source.NODE_ENV === "production" && !/^https:\/\//.test(base)) {
    throw new EmailConfigError("APP_BASE_URL must be the public https:// address of the site so email links work");
  }
  const timeout = Number(source.RESEND_TIMEOUT_MS ?? 20_000);
  const name = (source.RESEND_FROM_NAME ?? "").replace(/["<>\r\n\\]/g, "").trim();
  return {
    apiKey,
    fromEmail,
    from: name ? `"${name}" <${fromEmail}>` : fromEmail,
    replyTo,
    timeoutMs: Number.isFinite(timeout) ? Math.min(Math.max(timeout, 3_000), 60_000) : 20_000,
    webhookSecret,
    testSender: fromEmail.toLowerCase().endsWith("@resend.dev"),
  };
}

export function resendConfigStatus():
  | { ok: true; fromEmail: string; testSender: boolean; webhooks: boolean }
  | { ok: false; error: string } {
  try {
    const c = resendConfig();
    return { ok: true, fromEmail: c.fromEmail, testSender: c.testSender, webhooks: !!c.webhookSecret };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

const clients = new Map<string, Resend>();
function client(apiKey: string) {
  let c = clients.get(apiKey);
  if (!c) clients.set(apiKey, (c = new Resend(apiKey)));
  return c;
}

const NOT_RETRYABLE: Record<string, EmailErrorCategory> = {
  missing_api_key: "config",
  invalid_api_key: "config",
  restricted_api_key: "config",
  invalid_access: "config",
  invalid_region: "config",
  invalid_from_address: "config",
  invalid_attachment: "attachment",
  validation_error: "rejected",
  invalid_parameter: "rejected",
  missing_required_field: "rejected",
  security_error: "rejected",
  not_found: "rejected",
  method_not_allowed: "rejected",
  invalid_idempotent_request: "idempotency_conflict",
  invalid_idempotency_key: "idempotency_conflict",
};

function retryAfter(headers: Record<string, string> | null): number | null {
  const v = headers?.["retry-after"];
  const s = v ? Number(v) : NaN;
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, 3_600_000) : null;
}

export function classifyResendError(
  error: { name?: string; message?: string; statusCode?: number | null },
  headers: Record<string, string> | null,
): EmailSendError {
  const code = error.name ?? "application_error";
  const msg = `Resend ${code}${error.statusCode ? ` (HTTP ${error.statusCode})` : ""}: ${(error.message ?? "").slice(0, 300)}`;
  if (NOT_RETRYABLE[code]) {
    // A 403 validation_error is what Resend returns for an unverified domain / test sender to a stranger.
    return new EmailSendError(msg, NOT_RETRYABLE[code], { retryable: false, providerCode: code });
  }
  if (code === "daily_quota_exceeded" || code === "monthly_quota_exceeded") {
    return new EmailSendError(msg, "quota", { retryable: true, retryAfterMs: retryAfter(headers) ?? 3_600_000, providerCode: code });
  }
  if (code === "rate_limit_exceeded" || error.statusCode === 429) {
    return new EmailSendError(msg, "rate_limited", { retryable: true, retryAfterMs: retryAfter(headers), providerCode: code });
  }
  if (code === "concurrent_idempotent_requests") {
    // Another worker is mid-request with the same key: wait, then the replay returns its result.
    return new EmailSendError(msg, "uncertain", { retryable: true, uncertain: true, retryAfterMs: 5_000, providerCode: code });
  }
  // 5xx, network failure (statusCode null) or unknown: the email may or may not exist.
  return new EmailSendError(msg, error.statusCode ? "provider_unavailable" : "uncertain", { retryable: true, uncertain: true, providerCode: code });
}

export type ResendMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  idempotencyKey: string;
  tags?: Record<string, string>;
  replyTo?: string;
};

export async function sendWithResend(cfg: ResendConfig, msg: ResendMessage): Promise<{ id: string }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new EmailSendError("Resend request timed out", "uncertain", { retryable: true, uncertain: true })),
      cfg.timeoutMs,
    );
    timer.unref?.();
  });
  try {
    const res = await Promise.race([
      client(cfg.apiKey).emails.send(
        {
          from: cfg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(msg.replyTo || cfg.replyTo ? { replyTo: msg.replyTo || cfg.replyTo } : {}),
          // Base64 string: the documented wire format (a raw Buffer would be JSON-encoded as a number array).
          attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), contentType: a.contentType })),
          tags: Object.entries(msg.tags ?? {}).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) })),
          headers: { "X-Entity-Ref-ID": msg.idempotencyKey },
        },
        { idempotencyKey: msg.idempotencyKey },
      ),
      timeout,
    ]);
    if (res.error) throw classifyResendError(res.error, res.headers);
    if (!res.data?.id) throw new EmailSendError("Resend accepted the request without an email id", "uncertain", { retryable: true, uncertain: true });
    return { id: res.data.id };
  } catch (err) {
    if (err instanceof EmailSendError) throw err;
    throw new EmailSendError(`Resend request failed: ${(err as Error).name}`, "uncertain", { retryable: true, uncertain: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Looks up an accepted email's latest state (admin "refresh"), e.g. "delivered" or "bounced". */
export async function fetchResendEmailStatus(cfg: ResendConfig, emailId: string): Promise<string | null> {
  const res = await client(cfg.apiKey).emails.get(emailId);
  if (res.error) throw classifyResendError(res.error, res.headers);
  return (res.data as { last_event?: string } | null)?.last_event ?? null;
}

/**
 * Whether the sender's domain is verified in Resend. "unknown" with a
 * sending-only (restricted) key, which can't read domains.
 */
export async function senderDomainStatus(cfg: ResendConfig): Promise<{ domain: string; status: string }> {
  const domain = cfg.fromEmail.split("@")[1].toLowerCase();
  if (cfg.testSender) return { domain, status: "resend test sender (delivers only to your Resend account email)" };
  const res = await client(cfg.apiKey).domains.list();
  if (res.error) return { domain, status: res.error.name === "restricted_api_key" ? "unknown (sending-only API key)" : `unknown (${res.error.name})` };
  const found = (res.data?.data ?? []).find((d: { name: string }) => d.name.toLowerCase() === domain);
  return { domain, status: found ? (found as { status: string }).status : "not added to Resend" };
}

/** Signature check for Resend webhooks (Svix / Standard Webhooks: id + timestamp + HMAC, 5-minute tolerance). */
export function verifyResendWebhook(payload: string, headers: Headers, secret: string): unknown {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !signature) throw new Error("Missing webhook signature headers");
  // verify() needs no network access or API key; the constructor just insists on a non-empty one.
  return new Resend(process.env.RESEND_API_KEY || "re_verify_only").webhooks.verify({
    payload,
    headers: { id, timestamp, signature },
    webhookSecret: secret,
  });
}

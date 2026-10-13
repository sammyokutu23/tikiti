/**
 * QR payload format: "TKT1.<ticket code>.<signature>"
 *  - ticket code: 16 random chars (≈78 bits), the DB lookup key
 *  - signature: truncated HMAC-SHA256 so forged/garbled payloads are rejected
 *    before touching the database.
 * The payload contains no personal data. A valid signature does NOT make a
 * ticket valid — the scanner always checks the ticket row server-side.
 */
import { env } from "@/lib/env";
import { hmacBase64Url, safeEqual } from "@/lib/crypto";

const PREFIX = "TKT1";
const CODE_RE = /^[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}-[2-9A-HJ-NP-TV-Z]{4}$/;

function sign(code: string) {
  return hmacBase64Url(env.qrSigningSecret, `ticket:${code}`, 16);
}

export function buildQrPayload(code: string): string {
  return `${PREFIX}.${code}.${sign(code)}`;
}

export type ParsedScan =
  | { ok: true; code: string; source: "qr" | "manual" }
  | { ok: false; reason: "malformed" | "bad_signature" };

/** Accepts a scanned QR payload or a manually typed ticket code. */
export function parseScanInput(raw: string): ParsedScan {
  const input = raw.trim();
  if (input.startsWith(`${PREFIX}.`)) {
    const parts = input.split(".");
    if (parts.length !== 3 || !CODE_RE.test(parts[1])) return { ok: false, reason: "malformed" };
    return safeEqual(parts[2], sign(parts[1]))
      ? { ok: true, code: parts[1], source: "qr" }
      : { ok: false, reason: "bad_signature" };
  }
  const compact = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (compact.length !== 16) return { ok: false, reason: "malformed" };
  const code = compact.match(/.{4}/g)!.join("-");
  return CODE_RE.test(code) ? { ok: true, code, source: "manual" } : { ok: false, reason: "malformed" };
}

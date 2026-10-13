import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function hmacBase64Url(secret: string, data: string, bytes = 32): string {
  return hmac(secret, data).subarray(0, bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// Crockford-style alphabet without ambiguous characters (no 0/O, 1/I/L, U).
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Cryptographically random code, e.g. randomCode(12) → "K7QM2XPA9DRT". */
export function randomCode(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** Booking reference, e.g. "TK-7KQ2-9XHM" (~39 bits; identifies, never authorizes). */
export function newBookingReference(): string {
  const c = randomCode(8);
  return `TK-${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Ticket code, e.g. "K7QM-2XPA-9DRT-HWZB" (16 chars ≈ 78 bits of entropy). */
export function newTicketCode(): string {
  const c = randomCode(16);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12)}`;
}

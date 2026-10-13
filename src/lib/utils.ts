import clsx, { type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Normalises Kenyan phone numbers to 2547XXXXXXXX / 2541XXXXXXXX, or null. */
export function normalizeKenyanPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, "").replace(/^\+/, "");
  let n = digits;
  if (/^0[17]\d{8}$/.test(n)) n = "254" + n.slice(1);
  else if (/^[17]\d{8}$/.test(n)) n = "254" + n;
  return /^254[17]\d{8}$/.test(n) ? n : null;
}

export function formatPhone(n: string) {
  return /^254\d{9}$/.test(n) ? `+254 ${n.slice(3, 6)} ${n.slice(6, 9)} ${n.slice(9)}` : n;
}

export function maskEmail(email: string) {
  const [u, d] = email.split("@");
  if (!d) return email;
  return `${u.slice(0, 2)}${"•".repeat(Math.max(1, u.length - 2))}@${d}`;
}

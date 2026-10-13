import type { ZodError } from "zod";

export type FormState = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
  /** Changes on each successful submit — used to reset uncontrolled forms. */
  nonce?: number;
};

export function fieldErrors(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const key = issue.path.join(".");
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

export function formValues(fd: FormData, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, String(fd.get(k) ?? "")]));
}

/** Safe in-app redirect target (prevents open redirects). */
export function safeNext(next: unknown, fallback = "/"): string {
  const s = typeof next === "string" ? next : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : fallback;
}

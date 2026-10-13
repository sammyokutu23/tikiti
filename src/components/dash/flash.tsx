import { Alert } from "@/components/ui";

/** Renders ?ok= / ?error= messages set by server-action redirects. */
export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const ok = typeof sp.ok === "string" ? sp.ok : null;
  const err = typeof sp.error === "string" ? sp.error : null;
  if (!ok && !err) return null;
  return (
    <Alert tone={err ? "danger" : "success"} className="mb-6">
      {(err ?? ok)!.slice(0, 300)}
    </Alert>
  );
}

export function withFlash(path: string, kind: "ok" | "error", msg: string) {
  return `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}`;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { AlertTriangle, Camera, CameraOff, CheckCircle2, Keyboard, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

type Result = {
  result: "accepted" | "already_checked_in" | "revoked" | "refunded" | "invalid" | "wrong_event" | "not_confirmed";
  message: string;
  ticket?: { code: string; ticketType: string; attendeeName: string | null; bookingReference: string; checkedInAt: string | null };
};

const TONE: Record<Result["result"], "ok" | "warn" | "bad"> = {
  accepted: "ok",
  already_checked_in: "warn",
  revoked: "bad",
  refunded: "bad",
  invalid: "bad",
  wrong_event: "bad",
  not_confirmed: "bad",
};

export function Scanner({ eventId }: { eventId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastRef = useRef<{ raw: string; at: number }>({ raw: "", at: 0 });
  const busyRef = useRef(false);
  const [camera, setCamera] = useState<"off" | "starting" | "on" | "error">("off");
  const [camError, setCamError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [history, setHistory] = useState<(Result & { at: Date })[]>([]);
  const [manual, setManual] = useState("");

  const submit = useCallback(
    async (raw: string) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        const res = await fetch(`/api/organizer/events/${eventId}/scan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw }),
        });
        const data: Result = res.ok ? await res.json() : { result: "invalid", message: res.status === 429 ? "Too many scans — slow down" : "Scan failed — check connection" };
        setResult(data);
        setHistory((h) => [{ ...data, at: new Date() }, ...h].slice(0, 20));
        if (navigator.vibrate) navigator.vibrate(TONE[data.result] === "ok" ? 80 : [60, 60, 60]);
      } catch {
        setResult({ result: "invalid", message: "Network error — try again" });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [eventId],
  );

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera("off");
  }, []);

  const start = async () => {
    setCamError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamera("error");
      setCamError("Camera isn't available in this browser. Use manual entry below (camera needs HTTPS or localhost).");
      return;
    }
    setCamera("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      const v = videoRef.current!;
      v.srcObject = stream;
      await v.play();
      setCamera("on");
    } catch (e) {
      setCamera("error");
      setCamError((e as Error).name === "NotAllowedError" ? "Camera permission was denied. Allow camera access or use manual entry." : "Couldn't start the camera. Use manual entry.");
    }
  };

  useEffect(() => {
    if (camera !== "on") return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2 && !busyRef.current) {
        const w = 480;
        const h = Math.round((v.videoHeight / v.videoWidth) * w) || 360;
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
        if (code?.data) {
          const now = Date.now();
          // Debounce the same code for 3s so one ticket isn't submitted repeatedly.
          if (code.data !== lastRef.current.raw || now - lastRef.current.at > 3000) {
            lastRef.current = { raw: code.data, at: now };
            submit(code.data);
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [camera, submit]);

  useEffect(() => stop, [stop]);

  const tone = result ? TONE[result.result] : null;
  const counts = history.reduce((a, h) => ((a[TONE[h.result]] = (a[TONE[h.result]] ?? 0) + 1), a), {} as Record<string, number>);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        <div className="relative aspect-[4/3] overflow-hidden rounded-[2rem] border border-line bg-black">
          <video ref={videoRef} className={cn("size-full object-cover", camera !== "on" && "hidden")} playsInline muted />
          <canvas ref={canvasRef} className="hidden" />
          {camera === "on" && <div className="pointer-events-none absolute inset-[18%] rounded-3xl border-2 border-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" aria-hidden />}
          {camera !== "on" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <Camera className="size-10 text-muted" aria-hidden />
              <p className="text-sm text-muted">{camera === "error" ? camError : "Point the camera at a ticket QR code."}</p>
              <button onClick={start} disabled={camera === "starting"} className="inline-flex h-12 items-center gap-2 rounded-full bg-primary px-6 font-semibold text-primary-fg disabled:opacity-60">
                {camera === "starting" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Camera className="size-4" aria-hidden />} Start camera
              </button>
            </div>
          )}
          {busy && <div className="absolute right-4 top-4 rounded-full bg-black/60 p-2"><Loader2 className="size-5 animate-spin text-white" aria-label="Checking" /></div>}
        </div>
        {camera === "on" && (
          <button onClick={stop} className="inline-flex items-center gap-2 text-sm text-muted hover:text-fg"><CameraOff className="size-4" aria-hidden />Stop camera</button>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (manual.trim()) submit(manual.trim());
          }}
          className="flex gap-2"
        >
          <label htmlFor="manual" className="sr-only">Ticket code</label>
          <div className="relative flex-1">
            <Keyboard className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <input id="manual" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Type ticket code, e.g. K7QM-2XPA-9DRT-HWZB" autoCapitalize="characters" className="h-12 w-full rounded-full border border-line bg-fg/5 pl-11 pr-4 font-mono text-sm uppercase focus:border-fg/40 focus:outline-none" />
          </div>
          <button disabled={busy || !manual.trim()} className="h-12 rounded-full bg-primary px-5 text-sm font-semibold text-primary-fg disabled:opacity-50">Check</button>
        </form>
      </div>

      <div className="space-y-4">
        <div
          role="status"
          aria-live="assertive"
          className={cn(
            "rounded-[2rem] border p-6 transition",
            !result && "border-line bg-surface/60",
            tone === "ok" && "border-success/40 bg-success/15",
            tone === "warn" && "border-warning/40 bg-warning/15",
            tone === "bad" && "border-danger/40 bg-danger/15",
          )}
        >
          {!result ? (
            <p className="text-sm text-muted">Scan results appear here.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                {tone === "ok" && <CheckCircle2 className="size-10 text-success" aria-hidden />}
                {tone === "warn" && <AlertTriangle className="size-10 text-warning" aria-hidden />}
                {tone === "bad" && <XCircle className="size-10 text-danger" aria-hidden />}
                <p className="text-2xl font-bold leading-tight">{result.message}</p>
              </div>
              {result.ticket && (
                <dl className="space-y-1 text-sm">
                  <div><dt className="inline text-muted">Ticket: </dt><dd className="inline font-mono">{result.ticket.code}</dd></div>
                  <div><dt className="inline text-muted">Type: </dt><dd className="inline">{result.ticket.ticketType}</dd></div>
                  <div><dt className="inline text-muted">Name: </dt><dd className="inline">{result.ticket.attendeeName ?? "—"}</dd></div>
                  {result.result === "already_checked_in" && result.ticket.checkedInAt && (
                    <div><dt className="inline text-muted">First scanned: </dt><dd className="inline">{new Date(result.ticket.checkedInAt).toLocaleTimeString("en-KE")}</dd></div>
                  )}
                </dl>
              )}
            </div>
          )}
        </div>
        {history.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs text-muted">This session: {counts.ok ?? 0} admitted · {counts.warn ?? 0} repeat · {counts.bad ?? 0} rejected</p>
            <ul className="space-y-1.5 text-sm">
              {history.map((h, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded-2xl bg-fg/4 px-3 py-2">
                  <span className="truncate">{h.ticket?.attendeeName ?? h.ticket?.code ?? "Unknown code"}</span>
                  <span className={cn("shrink-0 text-xs", TONE[h.result] === "ok" ? "text-success" : TONE[h.result] === "warn" ? "text-warning" : "text-danger")}>
                    {h.message} · {h.at.toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

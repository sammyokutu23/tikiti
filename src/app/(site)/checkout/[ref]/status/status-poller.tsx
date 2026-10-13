"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, Loader2, RotateCcw, Smartphone, Ticket, XCircle } from "lucide-react";
import { buttonClasses } from "@/components/ui";
import type { BookingPaymentView as Status } from "@/server/bookings/payment-view";

const FAILED = new Set(["failed", "cancelled", "expired"]);

/**
 * Polls the server for the booking state. The page never infers success from
 * the redirect itself — only a confirmed booking (set by a verified provider
 * callback) shows the success state.
 */
export function StatusPoller({ reference, access, initial }: { reference: string; access: string | null; initial: Status }) {
  const [s, setS] = useState<Status>(initial);
  const [elapsed, setElapsed] = useState(0);
  const started = useRef<number | null>(null);
  const q = access ? `?access=${encodeURIComponent(access)}` : "";

  const latest = s.latestPayment;
  const terminal = s.status !== "pending" || (latest ? FAILED.has(latest.status) : s.paymentStatus === "failed");
  const needsReview = latest?.status === "reconciliation_required";
  const sentAt = latest?.sentAt ?? null;

  useEffect(() => {
    if (terminal) return;
    let stop = false;
    started.current = sentAt ? new Date(sentAt).getTime() : Date.now();
    const tick = async () => {
      try {
        const res = await fetch(`/api/bookings/${reference}/status${q}`, { cache: "no-store" });
        if (res.ok && !stop) setS(await res.json());
      } catch {
        /* keep polling */
      }
      if (!stop) setElapsed(Math.floor((Date.now() - (started.current ?? Date.now())) / 1000));
    };
    tick();
    // Polls our own server only (never Daraja); slows down once the prompt has likely timed out.
    const t = setInterval(tick, needsReview ? 15_000 : 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [reference, q, terminal, needsReview, sentAt]);

  if (s.status === "confirmed") {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-success/15 text-success">
          <CheckCircle2 className="size-10" aria-hidden />
        </div>
        <div className="space-y-2" role="status">
          <h1 className="text-3xl font-bold tracking-tight">You&apos;re in! 🎉</h1>
          <p className="text-muted">
            Payment verified and booking <span className="font-mono text-fg">{reference}</span> is confirmed. Your {s.ticketCount} ticket{s.ticketCount === 1 ? "" : "s"} {s.ticketCount === 1 ? "is" : "are"} on the way to your inbox.
          </p>
        </div>
        <div className="space-y-3">
          <a href={`/api/bookings/${reference}/pdf${q}`} className={buttonClasses("primary", "lg", true)}>
            <Download className="size-5" aria-hidden /> Download tickets (PDF)
          </a>
          <Link href={`/bookings/${reference}${q}`} className={buttonClasses("secondary", "lg", true)}>
            <Ticket className="size-5" aria-hidden /> View tickets &amp; QR codes
          </Link>
        </div>
      </div>
    );
  }

  const failed = latest ? FAILED.has(latest.status) : s.paymentStatus === "failed";
  if (s.status === "pending" && failed) {
    const title = latest?.status === "cancelled" ? "Payment cancelled" : latest?.status === "expired" ? "Payment not completed" : "Payment failed";
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-danger/15 text-danger">
          <XCircle className="size-10" aria-hidden />
        </div>
        <div className="space-y-2" role="alert">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted">{latest?.failureReason ?? "The payment wasn't completed."} You haven&apos;t been charged. Your tickets are still reserved for a few minutes.</p>
        </div>
        <Link href={`/checkout/${reference}${q}`} className={buttonClasses("primary", "lg", true)}>
          <RotateCcw className="size-5" aria-hidden /> Try again
        </Link>
      </div>
    );
  }

  if (s.status === "pending" && needsReview) {
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-warning/15 text-warning">
          <AlertTriangle className="size-10" aria-hidden />
        </div>
        <div className="space-y-2" role="status">
          <h1 className="text-2xl font-bold tracking-tight">We&apos;re confirming your payment</h1>
          <p className="text-muted">
            M-Pesa hasn&apos;t given us a final answer yet, so we&apos;re checking it. If money left your M-Pesa account, your tickets will be issued — or the money refunded — once it&apos;s confirmed. We&apos;ll email you either way.
          </p>
          <p className="text-sm text-muted">Booking reference <span className="font-mono text-fg">{reference}</span></p>
        </div>
        <Link href={`/checkout/${reference}${q}`} className={buttonClasses("secondary", "lg", true)}>
          <RotateCcw className="size-5" aria-hidden /> No money left my account — try again
        </Link>
      </div>
    );
  }

  if (s.status !== "pending") {
    const map: Record<string, [string, string]> = {
      expired: ["Reservation expired", "We didn't receive a payment confirmation in time, so the tickets were released. If money left your account it will be refunded automatically."],
      cancelled: ["Order cancelled", "This order was cancelled and the tickets were released."],
      failed: ["Tickets sold out", "Your payment arrived after the tickets sold out. A full refund has been started automatically."],
      refunded: ["Booking refunded", "This booking has been refunded."],
    };
    const [title, body] = map[s.status] ?? ["Booking update", `Status: ${s.status}`];
    return (
      <div className="space-y-6 text-center">
        <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-white/8 text-muted">
          <Clock className="size-10" aria-hidden />
        </div>
        <div className="space-y-2" role="status">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <p className="text-muted">{body}</p>
        </div>
        <Link href={`/bookings/${reference}${q}`} className={buttonClasses("secondary", "lg", true)}>View booking</Link>
      </div>
    );
  }

  const isMpesaPrompt = latest?.provider === "daraja";
  if (isMpesaPrompt) {
    const unconfirmed = latest?.status === "created";
    return (
      <div className="space-y-6 text-center" role="status" aria-live="polite">
        <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-[#3bb54a]/15 text-[#3bb54a]">
          {unconfirmed ? <Loader2 className="size-10 animate-spin" aria-hidden /> : <Smartphone className="size-10" aria-hidden />}
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{unconfirmed ? "Contacting M-Pesa…" : "Check your phone"}</h1>
          {unconfirmed ? (
            <p className="text-muted">M-Pesa is slow to respond. If a prompt appears on your phone, enter your PIN there. Please don&apos;t start another payment.</p>
          ) : (
            <p className="text-muted">
              We sent an M-Pesa prompt to <span className="text-fg">{latest?.phone ?? "your phone"}</span>. Enter your M-Pesa PIN on your phone to pay — never on this website.
            </p>
          )}
          {elapsed > 60 && (
            <p className="text-sm text-muted">
              Still waiting for M-Pesa&apos;s confirmation, and we&apos;re checking with them. Please don&apos;t pay again. If the payment went through, your tickets will appear here and in your email.
            </p>
          )}
        </div>
        <Loader2 className="mx-auto size-5 animate-spin text-muted" aria-hidden />
      </div>
    );
  }

  return (
    <div className="space-y-6 text-center" role="status" aria-live="polite">
      <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-white/8">
        <Loader2 className="size-10 animate-spin" aria-hidden />
      </div>
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">Waiting for payment confirmation…</h1>
        <p className="text-muted">
          We&apos;re waiting for the payment provider to confirm. This usually takes a few seconds. Don&apos;t close this page.
        </p>
        {elapsed > 15 && (
          <p className="text-sm text-muted">Still waiting ({elapsed}s). Delayed confirmations are normal — we&apos;ll email your tickets as soon as it arrives.</p>
        )}
      </div>
    </div>
  );
}

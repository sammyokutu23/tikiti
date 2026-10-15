import Link from "next/link";
import QRCode from "qrcode";
import { CalendarDays, Download, MapPin, ShieldAlert, UserPlus } from "lucide-react";
import { EventImage } from "@/components/events/event-image";
import { Alert, Badge, ButtonLink, Card, EmptyState, StatusBadge, buttonClasses } from "@/components/ui";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatDateTime } from "@/lib/dates";
import { formatAmount, formatMoney } from "@/lib/money";
import { cn, formatPhone } from "@/lib/utils";
import { authorizeBooking } from "@/server/bookings/authorize";
import { bookingDetail } from "@/server/bookings/queries";
import { buildQrPayload } from "@/server/tickets/qr";
import { claimBookingAction } from "../actions";
import { ResendTicketsForm } from "../forms";
import { PlanPanel } from "../plan-panel";
import { Flash } from "@/components/dash/flash";
import { planView } from "@/server/plans/service";

export const metadata = { title: "Your booking", robots: { index: false } };

const EMAIL_STATUS: Record<string, string> = {
  queued: "Queued — sending shortly",
  sending: "Sending…",
  retry_pending: "Sending — retrying shortly",
  sent: "Handed to the mail provider",
  accepted: "Sent — waiting for your mail server to confirm",
  delivery_delayed: "Delayed by your mail server — still trying",
  delivered: "Delivered to your inbox provider",
  captured: "Captured locally (dev mode — no email provider configured)",
  failed: "Delivery failed — use “Email my tickets again” or download below",
  bounced: "Your mail server rejected it — download your tickets below or contact support to change the address",
  complained: "Marked as spam — download your tickets below",
  suppressed: "Not sent: this address previously bounced — download below or contact support",
};

export default async function BookingPage({ params, searchParams }: PageProps<"/bookings/[ref]">) {
  const { ref } = await params;
  const sp = await searchParams;
  const access = await authorizeBooking(ref, typeof sp.access === "string" ? sp.access : null);
  if (!access) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <EmptyState
          icon={<ShieldAlert className="size-6" />}
          title="This booking is private"
          body="Log in with the account used to book, or open the secure link from your confirmation email."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <ButtonLink href={`/sign-in?redirect_url=${encodeURIComponent(`/bookings/${ref}`)}`}>Sign in</ButtonLink>
              <ButtonLink href="/bookings/find" variant="secondary">Email me a link</ButtonLink>
            </div>
          }
        />
      </div>
    );
  }
  const d = (await bookingDetail(access.booking.id))!;
  const plan = await planView(access.booking.id);
  const { booking, event } = d;
  const q = access.token ? `?access=${encodeURIComponent(access.token)}` : "";
  const tz = event.timezone;
  const confirmed = booking.status === "confirmed";
  const latestEmail = d.emails.find((e) => e.kind === "booking_confirmation");

  const qrSvgs = confirmed
    ? await Promise.all(
        d.tickets.map(({ ticket }) =>
          QRCode.toString(buildQrPayload(ticket.code), { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#000000", light: "#ffffff" } }),
        ),
      )
    : [];

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 pb-16 pt-6 sm:px-6 sm:pt-10">
      <Flash sp={sp} />
      {sp.welcome && confirmed && (
        <Alert tone="success" title="Booking confirmed!">
          Your tickets are below and on their way to {booking.buyerEmail}.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="relative">
              <EventImage src={event.coverImageUrl} alt="" width={1200} className="aspect-[16/7] w-full" />
              <div className="absolute inset-0 img-fade" />
              <div className="absolute inset-x-5 bottom-4">
                <p className="text-sm text-white/80">Booking {booking.reference}</p>
                <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
                  <Link href={`/events/${event.slug}`} className="hover:underline">{event.title}</Link>
                </h1>
              </div>
            </div>
            <div className="grid gap-3 p-5 text-sm sm:grid-cols-2">
              <p className="flex items-center gap-2"><CalendarDays className="size-4 text-muted" aria-hidden />{formatDateTime(event.startsAt, tz)}</p>
              <p className="flex items-center gap-2"><MapPin className="size-4 text-muted" aria-hidden />{event.venueName}, {event.city}</p>
            </div>
          </Card>

          {event.status === "cancelled" && (
            <Alert tone="danger" title="This event was cancelled">{event.cancellationReason} Your booking has been refunded.</Alert>
          )}

          {plan && (
            <PlanPanel view={plan} reference={booking.reference} access={access.token} timezone={tz} phone={booking.buyerPhone} />
          )}

          {!confirmed ? (
            plan ? null : <Card className="p-5">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={booking.status} />
                <StatusBadge status={booking.paymentStatus} />
              </div>
              <p className="mt-3 text-sm text-muted">
                {booking.status === "pending" && "This booking is awaiting payment."}
                {booking.status === "expired" && "This reservation expired before payment was confirmed. Tickets were released."}
                {booking.status === "cancelled" && "This booking was cancelled."}
                {booking.status === "failed" && "Payment arrived after the tickets sold out. A full refund has been issued."}
                {booking.status === "refunded" && "This booking has been refunded. Its tickets are no longer valid for entry."}
              </p>
              {booking.status === "pending" && (
                <ButtonLink href={`/checkout/${booking.reference}${q}`} className="mt-4">Continue to payment</ButtonLink>
              )}
            </Card>
          ) : (
            <section className="space-y-4" aria-labelledby="tickets-h">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 id="tickets-h" className="text-xl font-semibold">Your tickets ({d.tickets.length})</h2>
                <a href={`/api/bookings/${booking.reference}/pdf${q}`} className={buttonClasses("primary", "md")}>
                  <Download className="size-4" aria-hidden /> Download all (PDF)
                </a>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {d.tickets.map(({ ticket, typeName }, i) => {
                  const usable = ticket.status === "valid" || ticket.status === "checked_in";
                  return (
                    <article key={ticket.id} className="overflow-hidden rounded-[1.75rem] border border-line bg-surface">
                      <div className="flex items-start justify-between gap-3 p-5 pb-3">
                        <div className="min-w-0">
                          <p className="text-xs text-muted">Ticket {i + 1} of {d.tickets.length}</p>
                          <p className="font-semibold">{typeName}</p>
                          <p className="truncate text-sm text-muted">{ticket.attendeeName}</p>
                        </div>
                        <StatusBadge status={ticket.status} />
                      </div>
                      <div className="relative mx-5 border-t border-dashed border-line-strong" aria-hidden>
                        <span className="absolute -left-8 -top-3 size-6 rounded-full bg-bg" />
                        <span className="absolute -right-8 -top-3 size-6 rounded-full bg-bg" />
                      </div>
                      <div className="flex flex-col items-center gap-3 p-5">
                        <div
                          className={cn("w-full max-w-[220px] rounded-2xl bg-white p-3", !usable && "opacity-25 grayscale")}
                          role="img"
                          aria-label={`QR code for ticket ${ticket.code}`}
                          dangerouslySetInnerHTML={{ __html: qrSvgs[i] }}
                        />
                        <p className="font-mono text-sm tracking-wider">{ticket.code}</p>
                        {ticket.status === "checked_in" && ticket.checkedInAt && (
                          <p className="text-xs text-info">Checked in {formatDateTime(ticket.checkedInAt, tz)}</p>
                        )}
                        {!usable && <p className="text-xs text-danger">Not valid for entry</p>}
                        <a
                          href={`/api/bookings/${booking.reference}/tickets/${ticket.code}/pdf${q}`}
                          className={buttonClasses("secondary", "sm")}
                        >
                          <Download className="size-4" aria-hidden /> Ticket PDF
                        </a>
                      </div>
                    </article>
                  );
                })}
              </div>
              <p className="text-xs text-subtle">Each QR code admits one person once. Don&apos;t share screenshots of your QR codes publicly.</p>
            </section>
          )}
        </div>

        <aside className="space-y-4">
          <Card className="space-y-3 p-5 text-sm">
            <h2 className="font-semibold">Order</h2>
            <dl className="space-y-2">
              {d.items.map((it) => (
                <div key={it.id} className="flex justify-between gap-3">
                  <dt className="text-fg/85">{it.quantity} × {it.ticketTypeName}</dt>
                  <dd className="tabular-nums">{formatAmount(it.lineTotalMinor)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3 border-t border-line pt-2 font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatMoney(booking.totalMinor)}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge>Booking: {booking.status}</Badge>
              <Badge>Payment: {booking.paymentStatus.replace("_", " ")}</Badge>
            </div>
            <div className="space-y-1 border-t border-line pt-3 text-xs text-muted">
              <p>{booking.buyerName}</p>
              <p>{booking.buyerEmail}</p>
              <p>{formatPhone(booking.buyerPhone)}</p>
            </div>
          </Card>

          {d.refunds.length > 0 && (
            <Card className="space-y-2 p-5 text-sm">
              <h2 className="font-semibold">Refunds</h2>
              {d.refunds.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-2">
                  <span className="tabular-nums">{formatMoney(r.amountMinor)}</span>
                  <StatusBadge status={r.status} />
                </div>
              ))}
            </Card>
          )}

          {confirmed && (
            <Card className="space-y-3 p-5 text-sm">
              <h2 className="font-semibold">Email delivery</h2>
              <p className="text-muted">{latestEmail ? EMAIL_STATUS[latestEmail.status] ?? latestEmail.status : "Not sent yet"}</p>
              <ResendTicketsForm reference={booking.reference} access={access.token} />
            </Card>
          )}

          {access.user && !booking.userId && (
            <Card className="space-y-3 p-5 text-sm">
              <p className="text-muted">Keep this booking in your Tikiti account.</p>
              <form action={claimBookingAction}>
                <input type="hidden" name="reference" value={booking.reference} />
                <input type="hidden" name="access" value={access.token ?? ""} />
                <SubmitButton variant="secondary" full><UserPlus className="size-4" aria-hidden /> Add to my account</SubmitButton>
              </form>
            </Card>
          )}
          {!access.user && (
            <p className="px-1 text-xs text-subtle">
              Bookmark this page or keep the confirmation email — the link is private to you. <Link href="/sign-up" className="underline">Create an account</Link> to keep tickets in one place.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

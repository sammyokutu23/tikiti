/**
 * Transactional email templates. Every template returns a subject, an HTML body
 * (table layout + inline styles, max-width 560px, readable on phones) and a
 * plain-text alternative. All dynamic values go through esc(); URLs are built
 * server-side from env.appUrl, never from user input.
 */
import { formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type Rendered = { subject: string; html: string; text: string };

type Audience = "customer" | "organizer" | "account";

const FOOTER: Record<Audience, string> = {
  customer: "You received this because a booking was made with this email address on Tikiti.",
  organizer: "You received this because you organise events on Tikiti.",
  account: "You received this because of activity on your Tikiti account.",
};

function layout(opts: { title: string; preheader: string; body: string; supportEmail: string; audience: Audience }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(opts.title)}</title></head>
<body style="margin:0;background:#f2f2f3;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(opts.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f2f3;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
<tr><td style="background:#111;padding:20px 28px;color:#fff;font-weight:800;font-size:20px;letter-spacing:.5px">TIKITI</td></tr>
<tr><td style="padding:28px">${opts.body}</td></tr>
<tr><td style="padding:18px 28px;border-top:1px solid #eee;color:#777;font-size:12px;line-height:1.5">
Questions? Reply to this email or contact <a href="mailto:${esc(opts.supportEmail)}" style="color:#111">${esc(opts.supportEmail)}</a>.<br>
${FOOTER[opts.audience]}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<a href="${esc(href)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:13px 22px;border-radius:999px;font-weight:600;font-size:14px">${esc(label)}</a>`;

const eyebrow = (s: string) => `<p style="margin:0 0 6px;color:#777;font-size:13px">${esc(s)}</p>`;
const h1 = (s: string) => `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">${s}</h1>`;
const para = (html: string, muted = false) =>
  `<p style="margin:0 0 16px;line-height:1.55;${muted ? "color:#555;font-size:13px" : ""}">${html}</p>`;
const note = (html: string) =>
  `<p style="margin:0 0 16px;padding:12px 14px;background:#f5f5f6;border-radius:12px;font-size:13px;line-height:1.5">${html}</p>`;

function details(rows: [string, string | null | undefined][]) {
  const r = rows
    .filter(([, v]) => v)
    .map(
      ([k, v]) =>
        `<tr><td style="color:#777;padding:4px 12px 4px 0;vertical-align:top;white-space:nowrap">${esc(k)}</td><td align="right" style="padding:4px 0">${v}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse;margin-bottom:16px">${r}</table>`;
}

const textBlock = (lines: (string | null | undefined | false)[]) => lines.filter((l) => l !== null && l !== undefined && l !== false).join("\n");
const firstName = (n: string) => n.trim().split(/\s+/)[0] || "there";

// ─── Customer: bookings ──────────────────────────────────────────────────────

export type BookingEmailData = {
  buyerName: string;
  reference: string;
  eventTitle: string;
  startsAt: Date;
  timezone: string;
  venue: string;
  items: { name: string; quantity: number; lineTotalMinor: number }[];
  /** One row per issued ticket (type + attendee); codes stay in the PDF. */
  tickets?: { ticketType: string; attendeeName: string; label: string }[];
  totalMinor: number;
  currency: string;
  ticketCount: number;
  ticketsUrl: string;
  eventUrl?: string;
  supportEmail: string;
  refundPolicy?: string;
  reason?: string;
  /** Exact-pin Google Maps directions; null when the organizer hasn't pinned the venue. */
  directionsUrl?: string | null;
  arrivalInstructions?: string;
  /** PDF wasn't attached (too large / unavailable): the email must point to the download link. */
  attachmentOmitted?: boolean;
  /** Final tickets after a Lipa Mdogo Mdogo plan was paid off. */
  planCompleted?: boolean;
};

function whenWhere(d: BookingEmailData) {
  return details([
    ["Booking reference", `<b>${esc(d.reference)}</b>`],
    ["When", esc(formatDateTime(d.startsAt, d.timezone))],
    [
      "Where",
      `${esc(d.venue)}${d.directionsUrl ? `<br><a href="${esc(d.directionsUrl)}" style="color:#1a52bf;font-weight:600">Get directions &rarr;</a>` : ""}`,
    ],
  ]);
}

export function bookingConfirmationEmail(d: BookingEmailData): Rendered {
  const subject = `Your tickets for ${d.eventTitle} — ${d.reference}`;
  const plural = d.ticketCount === 1 ? "ticket is" : `${d.ticketCount} tickets are`;
  const rows = d.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0">${i.quantity} × ${esc(i.name)}</td><td align="right" style="padding:6px 0">${formatMoney(i.lineTotalMinor, d.currency)}</td></tr>`,
    )
    .join("");
  const ticketRows = (d.tickets ?? [])
    .map(
      (t) =>
        `<tr><td style="padding:5px 0;color:#777;font-size:13px">${esc(t.label)}</td><td style="padding:5px 0">${esc(t.ticketType)}</td><td align="right" style="padding:5px 0">${esc(t.attendeeName)}</td></tr>`,
    )
    .join("");
  const intro = d.attachmentOmitted
    ? `Hi ${esc(firstName(d.buyerName))}, your booking is confirmed. Your ${plural} ready to download from the secure link below — each ticket has its own QR code for entry.`
    : `Hi ${esc(firstName(d.buyerName))}, your booking is confirmed. Your ${plural} attached as a PDF — each ticket has its own QR code for entry.`;
  const html = layout({
    title: subject,
    preheader: `Booking ${d.reference} is confirmed. ${d.ticketCount} ticket${d.ticketCount === 1 ? "" : "s"} inside.`,
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Booking confirmed")}
${h1(`You're going to ${esc(d.eventTitle)}!`)}
${para(intro)}
${d.planCompleted ? note("<b>Lipa Mdogo Mdogo complete.</b> Your payment plan is fully paid, so your entry tickets are now valid.") : ""}
${whenWhere(d)}
${d.arrivalInstructions ? note(`<b>Arrival:</b> ${esc(d.arrivalInstructions)}`) : ""}
${ticketRows ? `<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse;margin-bottom:12px">${ticketRows}</table>` : ""}
<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse;border-top:1px solid #eee;border-bottom:1px solid #eee;margin-bottom:20px">${rows}
<tr><td style="padding:8px 0;font-weight:700">Total paid</td><td align="right" style="font-weight:700">${formatMoney(d.totalMinor, d.currency)}</td></tr></table>
<p style="margin:0 0 22px">${button(d.ticketsUrl, d.attachmentOmitted ? "Download tickets" : "View & download tickets")}</p>
${para("This link is private to you — don't share it. Each QR code can be scanned only once.", true)}`,
  });
  const text = textBlock([
    `You're going to ${d.eventTitle}!`,
    d.planCompleted && "Your Lipa Mdogo Mdogo plan is fully paid, so your entry tickets are now valid.",
    "",
    `Booking reference: ${d.reference}`,
    `When: ${formatDateTime(d.startsAt, d.timezone)}`,
    `Where: ${d.venue}`,
    d.directionsUrl && `Directions: ${d.directionsUrl}`,
    d.arrivalInstructions && `Arrival: ${d.arrivalInstructions}`,
    "",
    ...(d.tickets ?? []).map((t) => `${t.label}: ${t.ticketType} — ${t.attendeeName}`),
    ...d.items.map((i) => `${i.quantity} x ${i.name} — ${formatMoney(i.lineTotalMinor, d.currency)}`),
    `Total paid: ${formatMoney(d.totalMinor, d.currency)}`,
    "",
    d.attachmentOmitted ? "Download your tickets here (private link — don't share it):" : "Your tickets are attached as a PDF. View and download them any time (private link — don't share it):",
    d.ticketsUrl,
    "",
    `Support: ${d.supportEmail}`,
  ]);
  return { subject, html, text };
}

export function bookingAccessEmail(d: BookingEmailData): Rendered {
  const subject = `Your booking link — ${d.reference}`;
  const html = layout({
    title: subject,
    preheader: `Secure link to booking ${d.reference}`,
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${h1("Here's your booking")}
${para(`Use the secure link below to view and download your tickets for <b>${esc(d.eventTitle)}</b> (${esc(d.reference)}).`)}
<p style="margin:0 0 20px">${button(d.ticketsUrl, "Open my booking")}</p>
${para("If you didn't request this, you can ignore this email.", true)}`,
  });
  return { subject, html, text: `Open your booking ${d.reference} for ${d.eventTitle}:\n${d.ticketsUrl}\n\nIf you didn't request this, ignore this email.` };
}

export function bookingRefundedEmail(d: BookingEmailData, cancelled: boolean): Rendered {
  const subject = cancelled ? `Cancelled: ${d.eventTitle} — refund for ${d.reference}` : `Refund for booking ${d.reference}`;
  const paid = d.totalMinor > 0;
  const html = layout({
    title: subject,
    preheader: cancelled ? `${d.eventTitle} has been cancelled.` : `Booking ${d.reference} was refunded.`,
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${h1(cancelled ? `${esc(d.eventTitle)} has been cancelled` : "Your booking was refunded")}
${para(`Hi ${esc(firstName(d.buyerName))}, ${cancelled ? "we're sorry — the organizer has cancelled this event." : "your booking has been refunded."} Your tickets for booking <b>${esc(d.reference)}</b> are no longer valid for entry.`)}
${d.reason ? para(`Reason: ${esc(d.reason)}`, true) : ""}
${para(
  paid
    ? `A refund of <b>${formatMoney(d.totalMinor, d.currency)}</b> has been initiated to your original payment method. We'll email you again once it has been completed.`
    : "This was a free booking, so no payment is involved.",
)}
<p style="margin:0">${button(d.ticketsUrl, "View booking")}</p>`,
  });
  return {
    subject,
    html,
    text: textBlock([
      cancelled ? `${d.eventTitle} has been cancelled.` : "Your booking was refunded.",
      `Booking ${d.reference}. Your tickets are no longer valid.`,
      d.reason && `Reason: ${d.reason}`,
      paid ? `A refund of ${formatMoney(d.totalMinor, d.currency)} has been initiated to your original payment method.` : "This was a free booking.",
      d.ticketsUrl,
    ]),
  };
}

export function refundCompletedEmail(d: BookingEmailData & { amountMinor: number; method: string }): Rendered {
  const subject = `Refund completed — ${d.reference}`;
  const amount = formatMoney(d.amountMinor, d.currency);
  const where = d.method === "mpesa" ? "to the M-Pesa number you paid with" : "to your original payment method";
  const html = layout({
    title: subject,
    preheader: `${amount} has been refunded.`,
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Refund completed")}
${h1(`${amount} is on its way back`)}
${para(`Hi ${esc(firstName(d.buyerName))}, the refund for booking <b>${esc(d.reference)}</b> (${esc(d.eventTitle)}) has been completed ${where}.`)}
${para("If you don't see it within a few days, reply to this email and we'll help.", true)}`,
  });
  return { subject, html, text: `Refund completed: ${amount} for booking ${d.reference} (${d.eventTitle}) has been sent ${where}.\nSupport: ${d.supportEmail}` };
}

// ─── Customer: payments ──────────────────────────────────────────────────────

export function paymentFailedEmail(d: BookingEmailData & { reason: string; retryUrl: string; holdOpen: boolean }): Rendered {
  const subject = `Payment not completed — ${d.eventTitle}`;
  const html = layout({
    title: subject,
    preheader: "Your tickets aren't confirmed yet.",
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Payment not completed")}
${h1("Your tickets aren't confirmed yet")}
${para(`Hi ${esc(firstName(d.buyerName))}, the payment for booking <b>${esc(d.reference)}</b> (${esc(d.eventTitle)}) didn't go through: ${esc(d.reason)}. No money was taken for this attempt.`)}
${para(d.holdOpen ? "Your tickets are still reserved for a short time — you can try again now." : "Your reservation has lapsed, but you can book again if tickets are still available.")}
<p style="margin:0 0 20px">${button(d.retryUrl, d.holdOpen ? "Try again" : "Book again")}</p>
${para("Never share your M-Pesa PIN. Tikiti will never ask for it — you only enter it on your phone's M-Pesa prompt.", true)}`,
  });
  return {
    subject,
    html,
    text: `Your payment for booking ${d.reference} (${d.eventTitle}) didn't go through: ${d.reason}. No money was taken for this attempt.\n${d.holdOpen ? "Try again" : "Book again"}: ${d.retryUrl}\n\nNever share your M-Pesa PIN.`,
  };
}

export function paymentReviewEmail(d: BookingEmailData): Rendered {
  const subject = `We're confirming your payment — ${d.reference}`;
  const html = layout({
    title: subject,
    preheader: "Please don't pay again.",
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Payment being confirmed")}
${h1("We're confirming your payment")}
${para(`Hi ${esc(firstName(d.buyerName))}, we haven't yet received a final answer from M-Pesa for booking <b>${esc(d.reference)}</b> (${esc(d.eventTitle)}). Our team is checking it.`)}
${note("<b>Please don't pay again.</b> If the money left your account, your tickets will be issued as soon as it's confirmed — or the payment will be reversed.")}
<p style="margin:0 0 20px">${button(d.ticketsUrl, "Check booking status")}</p>`,
  });
  return {
    subject,
    html,
    text: `We're confirming your M-Pesa payment for booking ${d.reference} (${d.eventTitle}). Please don't pay again — if money left your account, your tickets will be issued once it's confirmed, or the payment will be reversed.\n${d.ticketsUrl}`,
  };
}

// ─── Customer: event lifecycle ───────────────────────────────────────────────

export function eventReminderEmail(d: BookingEmailData): Rendered {
  const subject = `Reminder: ${d.eventTitle} is coming up`;
  const html = layout({
    title: subject,
    preheader: `${formatDateTime(d.startsAt, d.timezone)} · ${d.venue}`,
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Event reminder")}
${h1(`See you at ${esc(d.eventTitle)}`)}
${para(`Hi ${esc(firstName(d.buyerName))}, this is a reminder that your event is coming up. Have your ticket QR code${d.ticketCount === 1 ? "" : "s"} ready at the door.`)}
${whenWhere(d)}
${d.arrivalInstructions ? note(`<b>Arrival:</b> ${esc(d.arrivalInstructions)}`) : ""}
<p style="margin:0 0 20px">${button(d.ticketsUrl, "Open my tickets")}</p>`,
  });
  return {
    subject,
    html,
    text: textBlock([
      `Reminder: ${d.eventTitle}`,
      `When: ${formatDateTime(d.startsAt, d.timezone)}`,
      `Where: ${d.venue}`,
      d.directionsUrl && `Directions: ${d.directionsUrl}`,
      d.arrivalInstructions && `Arrival: ${d.arrivalInstructions}`,
      `Booking ${d.reference} — your tickets: ${d.ticketsUrl}`,
    ]),
  };
}

export function eventUpdatedEmail(d: BookingEmailData & { changes: string[] }): Rendered {
  const subject = `Important update: ${d.eventTitle}`;
  const list = d.changes.map((c) => `<li style="margin:0 0 4px">${esc(c)}</li>`).join("");
  const html = layout({
    title: subject,
    preheader: d.changes.join(" · "),
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Event update")}
${h1(`${esc(d.eventTitle)} has changed`)}
${para(`Hi ${esc(firstName(d.buyerName))}, the organizer has updated details for an event you're booked on (${esc(d.reference)}):`)}
<ul style="margin:0 0 16px;padding-left:20px;line-height:1.5">${list}</ul>
${whenWhere(d)}
${para("Your existing tickets remain valid. If you can no longer attend, reply to this email.", true)}
<p style="margin:0 0 20px">${button(d.ticketsUrl, "View my booking")}</p>`,
  });
  return {
    subject,
    html,
    text: textBlock([
      `${d.eventTitle} has changed:`,
      ...d.changes.map((c) => `- ${c}`),
      "",
      `When: ${formatDateTime(d.startsAt, d.timezone)}`,
      `Where: ${d.venue}`,
      `Your tickets remain valid: ${d.ticketsUrl}`,
    ]),
  };
}

// ─── Organizer ───────────────────────────────────────────────────────────────

export type OrganizerEmailData = {
  organizerName: string;
  eventTitle: string;
  startsAt: Date;
  timezone: string;
  eventUrl: string;
  dashboardUrl: string;
  supportEmail: string;
};

export function organizerEventPublishedEmail(d: OrganizerEmailData): Rendered {
  const subject = `Your event is live: ${d.eventTitle}`;
  const html = layout({
    title: subject,
    preheader: "Tickets are now on sale.",
    audience: "organizer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Event published")}
${h1(`${esc(d.eventTitle)} is live`)}
${para(`Hi ${esc(d.organizerName)}, your event on ${esc(formatDateTime(d.startsAt, d.timezone))} is published and tickets are on sale.`)}
<p style="margin:0 0 12px">${button(d.eventUrl, "View public page")}</p>
${para(`Track sales and check-ins from your <a href="${esc(d.dashboardUrl)}" style="color:#111">organizer dashboard</a>.`, true)}`,
  });
  return { subject, html, text: `${d.eventTitle} is live and tickets are on sale.\nPublic page: ${d.eventUrl}\nDashboard: ${d.dashboardUrl}` };
}

export function organizerEventAttentionEmail(d: OrganizerEmailData & { reason: string }): Rendered {
  const subject = `Action needed: ${d.eventTitle}`;
  const html = layout({
    title: subject,
    preheader: "Your event has been hidden from the marketplace.",
    audience: "organizer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Event needs attention")}
${h1(`${esc(d.eventTitle)} has been hidden`)}
${para(`Hi ${esc(d.organizerName)}, our team has hidden this event from public listings while an issue is resolved. Existing tickets remain valid.`)}
${note(`<b>Reason:</b> ${esc(d.reason)}`)}
<p style="margin:0 0 20px">${button(d.dashboardUrl, "Open dashboard")}</p>
${para("Reply to this email if you have questions or have fixed the issue.", true)}`,
  });
  return { subject, html, text: `${d.eventTitle} has been hidden from public listings.\nReason: ${d.reason}\nDashboard: ${d.dashboardUrl}\nReply to this email with any questions.` };
}

export function organizerNewSaleEmail(d: OrganizerEmailData & { reference: string; ticketCount: number; totalMinor: number; currency: string }): Rendered {
  const subject = `New booking for ${d.eventTitle} — ${d.ticketCount} ticket${d.ticketCount === 1 ? "" : "s"}`;
  const html = layout({
    title: subject,
    preheader: `${d.reference} · ${formatMoney(d.totalMinor, d.currency)}`,
    audience: "organizer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("New booking")}
${h1(`${d.ticketCount} ticket${d.ticketCount === 1 ? "" : "s"} sold`)}
${details([
  ["Event", esc(d.eventTitle)],
  ["Booking", `<b>${esc(d.reference)}</b>`],
  ["Total", d.totalMinor > 0 ? formatMoney(d.totalMinor, d.currency) : "Free"],
])}
<p style="margin:0 0 20px">${button(d.dashboardUrl, "View sales")}</p>`,
  });
  return {
    subject,
    html,
    text: `New booking ${d.reference} for ${d.eventTitle}: ${d.ticketCount} ticket(s), ${d.totalMinor > 0 ? formatMoney(d.totalMinor, d.currency) : "free"}.\n${d.dashboardUrl}`,
  };
}

export function organizerEventCancelledEmail(d: OrganizerEmailData & { reason: string; bookingCount: number }): Rendered {
  const subject = `Event cancelled: ${d.eventTitle}`;
  const html = layout({
    title: subject,
    preheader: `${d.bookingCount} booking${d.bookingCount === 1 ? "" : "s"} will be refunded.`,
    audience: "organizer",
    supportEmail: d.supportEmail,
    body: `${eyebrow("Event cancelled")}
${h1(`${esc(d.eventTitle)} has been cancelled`)}
${para(`Hi ${esc(d.organizerName)}, this event is now cancelled. ${d.bookingCount} confirmed booking${d.bookingCount === 1 ? " is" : "s are"} being refunded and every ticket holder has been notified.`)}
${d.reason ? note(`<b>Reason:</b> ${esc(d.reason)}`) : ""}
<p style="margin:0 0 20px">${button(d.dashboardUrl, "Open dashboard")}</p>`,
  });
  return { subject, html, text: `${d.eventTitle} has been cancelled. ${d.bookingCount} booking(s) are being refunded.${d.reason ? `\nReason: ${d.reason}` : ""}\n${d.dashboardUrl}` };
}

// ─── Customer: Lipa Mdogo Mdogo payment plans ────────────────────────────────

export type PlanEmailData = BookingEmailData & {
  paidMinor: number;
  outstandingMinor: number;
  finalDueAt: Date;
  schedule: { label: string; amountMinor: number; dueAt: Date; status: string }[];
  next: { label: string; amountMinor: number; dueAt: Date } | null;
};

const STATUS_WORD: Record<string, string> = {
  paid: "Paid",
  scheduled: "Upcoming",
  due: "Due",
  payment_pending: "Processing",
  failed: "Not paid",
  overdue: "Overdue",
  cancelled: "Cancelled",
};

function scheduleTable(d: PlanEmailData) {
  const rows = d.schedule
    .map(
      (l) =>
        `<tr><td style="padding:6px 0">${esc(l.label)}<br><span style="color:#777;font-size:12px">${esc(formatDateTime(l.dueAt, d.timezone))}</span></td><td align="right" style="padding:6px 0">${formatMoney(l.amountMinor, d.currency)}<br><span style="color:${l.status === "paid" ? "#15803d" : l.status === "overdue" ? "#b91c1c" : "#777"};font-size:12px">${esc(STATUS_WORD[l.status] ?? l.status)}</span></td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse;border-top:1px solid #eee;border-bottom:1px solid #eee;margin-bottom:16px">${rows}
<tr><td style="padding:8px 0;color:#777">Paid so far</td><td align="right">${formatMoney(d.paidMinor, d.currency)}</td></tr>
<tr><td style="padding:4px 0 8px;font-weight:700">Balance</td><td align="right" style="font-weight:700">${formatMoney(d.outstandingMinor, d.currency)}</td></tr></table>`;
}

const scheduleText = (d: PlanEmailData) => [
  ...d.schedule.map((l) => `${l.label}: ${formatMoney(l.amountMinor, d.currency)} — ${formatDateTime(l.dueAt, d.timezone)} (${STATUS_WORD[l.status] ?? l.status})`),
  `Paid so far: ${formatMoney(d.paidMinor, d.currency)} · Balance: ${formatMoney(d.outstandingMinor, d.currency)}`,
];

const PIN_NOTE = "Each payment is a separate M-Pesa prompt that you approve on your phone. Tikiti will never ask for your M-Pesa PIN.";

function planEmail(d: PlanEmailData, o: { subject: string; eyebrow: string; title: string; intro: string; preheader: string; noteHtml?: string; cta?: string; showSchedule?: boolean; extraText?: string[] }): Rendered {
  const html = layout({
    title: o.subject,
    preheader: o.preheader,
    audience: "customer",
    supportEmail: d.supportEmail,
    body: `${eyebrow(o.eyebrow)}
${h1(o.title)}
${para(o.intro)}
${o.noteHtml ? note(o.noteHtml) : ""}
${details([
  ["Event", esc(d.eventTitle)],
  ["When", esc(formatDateTime(d.startsAt, d.timezone))],
  ["Booking reference", `<b>${esc(d.reference)}</b>`],
])}
${o.showSchedule === false ? "" : scheduleTable(d)}
${o.cta ? `<p style="margin:0 0 20px">${button(d.ticketsUrl, o.cta)}</p>` : ""}
${para(PIN_NOTE, true)}`,
  });
  const text = textBlock([
    o.title,
    "",
    o.intro.replace(/<[^>]+>/g, ""),
    ...(o.extraText ?? []),
    "",
    `Event: ${d.eventTitle} — ${formatDateTime(d.startsAt, d.timezone)}`,
    `Booking reference: ${d.reference}`,
    ...(o.showSchedule === false ? [] : ["", ...scheduleText(d)]),
    "",
    d.ticketsUrl,
    "",
    PIN_NOTE,
    `Support: ${d.supportEmail}`,
  ]);
  return { subject: o.subject, html, text };
}

const nextLine = (d: PlanEmailData) =>
  d.next ? `Next payment: <b>${formatMoney(d.next.amountMinor, d.currency)}</b> by ${esc(formatDateTime(d.next.dueAt, d.timezone))}.` : "";

export function planDepositConfirmedEmail(d: PlanEmailData): Rendered {
  return planEmail(d, {
    subject: `Deposit received — your Lipa Mdogo Mdogo plan for ${d.eventTitle} is active`,
    eyebrow: "Payment plan active",
    title: "Your tickets are reserved",
    preheader: `Deposit received. Balance ${formatMoney(d.outstandingMinor, d.currency)}.`,
    intro: `Hi ${esc(firstName(d.buyerName))}, we've received your deposit and your Lipa Mdogo Mdogo plan is active. ${nextLine(d)}`,
    noteHtml: `Your entry tickets (with QR codes) are issued as soon as the full balance is paid — at the latest by <b>${esc(formatDateTime(d.finalDueAt, d.timezone))}</b>. No interest and no late fees.`,
    cta: "View plan & pay",
  });
}

export function planPaymentConfirmedEmail(d: PlanEmailData & { amountMinor: number }): Rendered {
  return planEmail(d, {
    subject: `Installment received — ${formatMoney(d.outstandingMinor, d.currency)} left for ${d.eventTitle}`,
    eyebrow: "Installment received",
    title: `Thanks — ${formatMoney(d.amountMinor, d.currency)} received`,
    preheader: `Balance ${formatMoney(d.outstandingMinor, d.currency)}.`,
    intro: `Hi ${esc(firstName(d.buyerName))}, your installment for booking <b>${esc(d.reference)}</b> has been confirmed. ${nextLine(d)}`,
    cta: "View plan & pay",
  });
}

export function planPaymentFailedEmail(d: PlanEmailData & { reason: string }): Rendered {
  return planEmail(d, {
    subject: `Installment not completed — ${d.eventTitle}`,
    eyebrow: "Payment not completed",
    title: "Your installment didn't go through",
    preheader: "No money was taken for this attempt.",
    intro: `Hi ${esc(firstName(d.buyerName))}, the M-Pesa payment for your installment didn't go through: ${esc(d.reason)}. No money was taken for this attempt and your plan is still active. ${nextLine(d)}`,
    cta: "Try again",
  });
}

export function planInstallmentDueEmail(d: PlanEmailData): Rendered {
  return planEmail(d, {
    subject: `Reminder: ${d.next ? formatMoney(d.next.amountMinor, d.currency) : "an installment"} due for ${d.eventTitle}`,
    eyebrow: "Installment due soon",
    title: "Your next installment is coming up",
    preheader: d.next ? `${formatMoney(d.next.amountMinor, d.currency)} due ${formatDateTime(d.next.dueAt, d.timezone)}.` : "Installment due soon.",
    intro: `Hi ${esc(firstName(d.buyerName))}, a friendly reminder about your Lipa Mdogo Mdogo plan. ${nextLine(d)} You can pay early at any time.`,
    cta: "Pay now with M-Pesa",
  });
}

export function planInstallmentOverdueEmail(d: PlanEmailData & { graceEndsAt: Date }): Rendered {
  return planEmail(d, {
    subject: `Installment overdue — keep your tickets for ${d.eventTitle}`,
    eyebrow: "Installment overdue",
    title: "Your installment is overdue",
    preheader: `Pay by ${formatDateTime(d.graceEndsAt, d.timezone)} to keep your tickets.`,
    intro: `Hi ${esc(firstName(d.buyerName))}, we haven't received your installment yet. There's no late fee — but please pay by <b>${esc(formatDateTime(d.graceEndsAt, d.timezone))}</b> to keep your tickets.`,
    noteHtml: "If the plan ends because of a missed payment, your tickets are released and the money you've paid is refunded as described in your plan terms.",
    cta: "Pay now with M-Pesa",
  });
}

export function planFinalDeadlineEmail(d: PlanEmailData): Rendered {
  return planEmail(d, {
    subject: `Final payment deadline for ${d.eventTitle}: ${formatDateTime(d.finalDueAt, d.timezone)}`,
    eyebrow: "Final deadline approaching",
    title: `${formatMoney(d.outstandingMinor, d.currency)} left to pay`,
    preheader: `Pay by ${formatDateTime(d.finalDueAt, d.timezone)} to get your tickets.`,
    intro: `Hi ${esc(firstName(d.buyerName))}, your balance must be paid by <b>${esc(formatDateTime(d.finalDueAt, d.timezone))}</b>. Once it's paid, your entry tickets are issued straight away.`,
    cta: "Pay now with M-Pesa",
  });
}

const END_REASON: Record<string, string> = {
  missed_installment: "an installment wasn't paid in time",
  deadline_passed: "the balance wasn't paid by the final deadline",
  customer_cancelled: "you cancelled it",
  admin_cancelled: "it was cancelled by Tikiti support",
  event_cancelled: "the event was cancelled",
};

export function planEndedEmail(d: PlanEmailData & { reason: string; refundMinor: number; retainedMinor: number }): Rendered {
  const why = END_REASON[d.reason] ?? "it ended";
  const refund =
    d.refundMinor > 0
      ? `We've started a refund of <b>${formatMoney(d.refundMinor, d.currency)}</b> to the M-Pesa number you paid with. We'll email you again once it's completed.${d.retainedMinor > 0 ? ` A ${formatMoney(d.retainedMinor, d.currency)} cancellation fee was kept, as set out in the plan terms you accepted.` : ""}`
      : "No payments had been made, so there's nothing to refund.";
  return planEmail(d, {
    subject: `Your payment plan for ${d.eventTitle} has ended`,
    eyebrow: "Payment plan ended",
    title: "Your payment plan has ended",
    preheader: d.refundMinor > 0 ? `Refund of ${formatMoney(d.refundMinor, d.currency)} started.` : "Your reserved tickets were released.",
    intro: `Hi ${esc(firstName(d.buyerName))}, your Lipa Mdogo Mdogo plan for booking <b>${esc(d.reference)}</b> ended because ${esc(why)}. The reserved tickets have been released.`,
    noteHtml: refund,
    showSchedule: false,
    cta: d.reason === "event_cancelled" ? undefined : "View booking",
  });
}

export function planPaymentReviewEmail(d: PlanEmailData): Rendered {
  return planEmail(d, {
    subject: `We're reviewing a payment on your plan — ${d.reference}`,
    eyebrow: "Payment under review",
    title: "We received a payment we need to check",
    preheader: "Please don't pay again.",
    intro: `Hi ${esc(firstName(d.buyerName))}, an M-Pesa payment for booking <b>${esc(d.reference)}</b> (${esc(d.eventTitle)}) arrived after your payment plan had ended. Our team is reviewing it.`,
    noteHtml: "<b>Please don't pay again.</b> Your money is safe: either your plan is reinstated with the payment applied, or the payment is refunded. We'll email you with the outcome.",
    showSchedule: false,
  });
}

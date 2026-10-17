/**
 * Server-side ticket PDF generation (pdf-lib — pure JS, no headless browser).
 * One A4 page per ticket; each page carries its own QR code and references so
 * a combined booking PDF still contains individually valid tickets.
 */
import {
  clip,
  endPath,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFName,
  PDFPage,
  PDFString,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rgb,
  StandardFonts,
} from "pdf-lib";
import QRCode from "qrcode";
import { formatEventDate, formatTime } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { directionsUrl, eventCoordinates, formatCoords } from "@/lib/location";
import { loadImageBytes } from "../storage";

export type TicketPdfData = {
  code: string;
  qrPayload: string;
  sequenceLabel: string; // "Ticket 1 of 3"
  ticketType: string;
  priceMinor: number;
  currency: string;
  attendeeName: string | null;
  bookingReference: string;
  status: string;
  event: {
    title: string;
    category: string;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    venueName: string;
    venueAddress: string;
    city: string;
    coverImageUrl: string | null;
    organizerName: string;
    latitude: number | null;
    longitude: number | null;
    arrivalInstructions: string;
  };
  supportEmail: string;
  /** Public recovery URL — never the private access link (it's a credential). */
  ticketPageUrl: string;
};

const INK = rgb(0.07, 0.07, 0.08);
const MUTED = rgb(0.42, 0.42, 0.45);
const LINE = rgb(0.85, 0.85, 0.87);
const WHITE = rgb(1, 1, 1);
const LINK = rgb(0.1, 0.32, 0.75);
const BRAND_GOLD = rgb(0.949, 0.722, 0.294); // #f2b84b

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const M = 42;

/**
 * `createdAt` pins the PDF's metadata dates so re-rendering the same tickets
 * yields identical bytes (an email retry must resend the exact same payload).
 */
export async function renderTicketsPdf(tickets: TicketPdfData[], opts: { createdAt?: Date } = {}): Promise<Uint8Array> {
  if (tickets.length === 0) throw new Error("No tickets to render");
  const pdf = await PDFDocument.create();
  if (opts.createdAt) {
    pdf.setCreationDate(opts.createdAt);
    pdf.setModificationDate(opts.createdAt);
  }
  pdf.setTitle(`${tickets[0].event.title} — Tickets ${tickets[0].bookingReference}`);
  pdf.setAuthor("TikoSoko");
  pdf.setSubject("Event ticket");
  pdf.setCreator("TikoSoko ticketing");
  pdf.setProducer("TikoSoko / pdf-lib");

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const coverCache = new Map<string, PDFImage | null>();
  for (const t of tickets) {
    const url = t.event.coverImageUrl;
    let cover: PDFImage | null = null;
    if (url) {
      if (!coverCache.has(url)) coverCache.set(url, await embedCover(pdf, url));
      cover = coverCache.get(url) ?? null;
    }
    const qr = await pdf.embedPng(await qrPng(t.qrPayload));
    drawTicketPage(pdf.addPage([PAGE_W, PAGE_H]), t, { regular, bold, cover, qr });
  }
  return pdf.save();
}

/** High-contrast QR PNG (ECC level M, quiet zone) as embedded in tickets. */
export function qrPng(payload: string): Promise<Buffer> {
  return QRCode.toBuffer(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    scale: 10,
    color: { dark: "#000000", light: "#FFFFFF" },
  });
}

async function embedCover(pdf: PDFDocument, url: string): Promise<PDFImage | null> {
  try {
    const bytes = await loadImageBytes(url);
    if (!bytes) return null;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await pdf.embedJpg(bytes);
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await pdf.embedPng(bytes);
    return null; // e.g. WebP — not supported by pdf-lib; ticket renders without cover.
  } catch {
    return null;
  }
}

type Fonts = { regular: PDFFont; bold: PDFFont; cover: PDFImage | null; qr: PDFImage };

function drawTicketPage(page: PDFPage, t: TicketPdfData, f: Fonts) {
  const { regular, bold } = f;
  const W = PAGE_W - 2 * M;
  let y = PAGE_H - M;

  // ── Header band ──
  const headerH = 58;
  roundedRect(page, M, y - headerH, W, headerH, 14, INK);
  text(page, "Tiko", M + 22, y - 36, bold, 22, WHITE);
  text(page, "Soko", M + 22 + bold.widthOfTextAtSize("Tiko", 22), y - 36, bold, 22, BRAND_GOLD);
  const tag = "E-TICKET  ·  ADMIT ONE";
  text(page, tag, M + W - 22 - bold.widthOfTextAtSize(tag, 9), y - 33, bold, 9, WHITE);
  y -= headerH + 14;

  // ── Cover image (cropped to fill) ──
  const coverH = 168;
  if (f.cover) {
    const scale = Math.max(W / f.cover.width, coverH / f.cover.height);
    const iw = f.cover.width * scale;
    const ih = f.cover.height * scale;
    page.pushOperators(pushGraphicsState(), rectangle(M, y - coverH, W, coverH), clip(), endPath());
    page.drawImage(f.cover, { x: M + (W - iw) / 2, y: y - coverH + (coverH - ih) / 2, width: iw, height: ih });
    page.pushOperators(popGraphicsState());
  } else {
    roundedRect(page, M, y - coverH, W, coverH, 0, rgb(0.15, 0.15, 0.17));
    text(page, safe(t.event.category.toUpperCase(), bold), M + 22, y - coverH / 2, bold, 12, rgb(0.6, 0.6, 0.62));
  }
  y -= coverH + 26;

  // ── Title ──
  text(page, safe(`${t.event.category.toUpperCase()}  ·  ${t.event.organizerName}`, bold), M, y, bold, 8.5, MUTED);
  y -= 24;
  for (const line of wrap(safe(t.event.title, bold), bold, 22, W).slice(0, 2)) {
    text(page, line, M, y, bold, 22, INK);
    y -= 27;
  }
  y -= 6;

  // ── Details grid ──
  const col = W / 2;
  const tz = t.event.timezone;
  const rows: [string, string, string, string][] = [
    sameDay(t.event.startsAt, t.event.endsAt, tz)
      ? ["DATE", formatEventDate(t.event.startsAt, tz), "TIME", `${formatTime(t.event.startsAt, tz)} – ${formatTime(t.event.endsAt, tz)} (${tzLabel(tz)})`]
      : ["STARTS", `${formatEventDate(t.event.startsAt, tz)}, ${formatTime(t.event.startsAt, tz)}`, "ENDS", `${formatEventDate(t.event.endsAt, tz)}, ${formatTime(t.event.endsAt, tz)} (${tzLabel(tz)})`],
    ["VENUE", t.event.venueName, "LOCATION", [t.event.venueAddress, t.event.city].filter(Boolean).join(", ")],
    ["TICKET TYPE", t.ticketType, "PRICE", formatMoney(t.priceMinor, t.currency)],
    ["ATTENDEE", t.attendeeName ?? "—", "BOOKING REFERENCE", t.bookingReference],
  ];
  for (const [l1, v1, l2, v2] of rows) {
    text(page, l1, M, y, bold, 7.5, MUTED);
    text(page, l2, M + col, y, bold, 7.5, MUTED);
    const v1Lines = wrap(safe(v1, regular), regular, 11, col - 16).slice(0, 2);
    const v2Lines = wrap(safe(v2, regular), regular, 11, col - 4).slice(0, 2);
    v1Lines.forEach((ln, i) => text(page, ln, M, y - 15 - i * 13, regular, 11, INK));
    v2Lines.forEach((ln, i) => text(page, ln, M + col, y - 15 - i * 13, regular, 11, INK));
    y -= 22 + Math.max(v1Lines.length, v2Lines.length) * 13 + 4;
  }

  // ── Directions (clickable) ──
  const coords = eventCoordinates(t.event);
  if (coords) {
    const label = "Get directions in Google Maps";
    text(page, label, M, y, bold, 10, LINK);
    const w = bold.widthOfTextAtSize(label, 10);
    page.drawLine({ start: { x: M, y: y - 2 }, end: { x: M + w, y: y - 2 }, thickness: 0.6, color: LINK });
    addLink(page, directionsUrl(coords), M, y - 4, w, 14);
    text(page, `GPS ${formatCoords(coords)}`, M + w + 12, y, regular, 9, MUTED);
    y -= 18;
  }
  if (t.event.arrivalInstructions) {
    for (const ln of wrap(safe(`Arrival: ${t.event.arrivalInstructions}`, regular), regular, 9, W).slice(0, 3)) {
      text(page, ln, M, y, regular, 9, INK);
      y -= 12;
    }
    y -= 2;
  }

  // ── Perforation ──
  y -= 4;
  dashedLine(page, M, y, M + W, y);
  y -= 20;

  // ── Stub with QR ──
  const qrSize = 176;
  const qrX = M + W - qrSize;
  page.drawRectangle({ x: qrX - 6, y: y - qrSize - 6, width: qrSize + 12, height: qrSize + 12, color: WHITE, borderColor: LINE, borderWidth: 1 });
  page.drawImage(f.qr, { x: qrX, y: y - qrSize, width: qrSize, height: qrSize });

  let sy = y - 4;
  text(page, "TICKET CODE", M, sy, bold, 7.5, MUTED);
  sy -= 22;
  text(page, t.code, M, sy, bold, 19, INK);
  sy -= 26;
  text(page, safe(t.sequenceLabel, regular), M, sy, regular, 10, MUTED);
  sy -= 28;
  if (t.status !== "valid" && t.status !== "checked_in") {
    const label = `STATUS: ${t.status.toUpperCase()} — NOT VALID FOR ENTRY`;
    roundedRect(page, M, sy - 8, bold.widthOfTextAtSize(label, 9) + 20, 24, 6, rgb(0.75, 0.1, 0.1));
    text(page, label, M + 10, sy, bold, 9, WHITE);
    sy -= 34;
  }
  text(page, "HOW TO ENTER", M, sy, bold, 7.5, MUTED);
  sy -= 15;
  const steps = [
    "1. Show this QR code (printed or on your phone) at the entrance.",
    "2. Each ticket admits one person and can be scanned only once.",
    "3. Bring a valid ID. Don't share or post your QR code online.",
  ];
  for (const s of steps) {
    for (const ln of wrap(s, regular, 9.5, W - qrSize - 30)) {
      text(page, ln, M, sy, regular, 9.5, INK);
      sy -= 13;
    }
  }
  y = Math.min(sy, y - qrSize - 6) - 24;

  // ── Footer ──
  dashedLine(page, M, y, M + W, y);
  y -= 18;
  const footer = [
    `Need help? ${t.supportEmail}  ·  Booking ${t.bookingReference}`,
    `Lost this ticket? Use the link in your confirmation email, or recover your booking at ${t.ticketPageUrl}`,
    "Refunds follow the event's refund policy. TikoSoko verifies every ticket at the gate — copies or edited tickets are rejected.",
  ];
  for (const ln of footer.flatMap((l) => wrap(safe(l, regular), regular, 8, W))) {
    text(page, ln, M, y, regular, 8, MUTED);
    y -= 11;
  }
}

// ── helpers ──

/** Adds a clickable URI link annotation over a rectangle (pdf-lib has no high-level API for this). */
function addLink(page: PDFPage, url: string, x: number, y: number, w: number, h: number) {
  const ctx = page.doc.context;
  const annot = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    }),
  );
  const existing = page.node.lookup(PDFName.of("Annots"));
  if (existing && "push" in (existing as object)) (existing as unknown as { push: (r: unknown) => void }).push(annot);
  else page.node.set(PDFName.of("Annots"), ctx.obj([annot]));
}

function text(page: PDFPage, s: string, x: number, y: number, font: PDFFont, size: number, color = INK) {
  page.drawText(s, { x, y, size, font, color });
}

function roundedRect(page: PDFPage, x: number, y: number, w: number, h: number, r: number, color: ReturnType<typeof rgb>) {
  if (r <= 0) {
    page.drawRectangle({ x, y, width: w, height: h, color });
    return;
  }
  // drawSvgPath uses a top-left origin at (x, y+h) with y pointing down.
  const p = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
  page.drawSvgPath(p, { x, y: y + h, color });
}

function dashedLine(page: PDFPage, x1: number, y1: number, x2: number, y2: number) {
  page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1, color: LINE, dashArray: [4, 4] });
}

function wrap(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) cur = next;
    else {
      if (cur) lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/** Standard PDF fonts are WinAnsi-encoded; replace characters they can't draw. */
function safe(s: string, font: PDFFont): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      try {
        font.encodeText(base);
        out += base;
      } catch {
        out += "";
      }
    }
  }
  return out;
}

function sameDay(a: Date, b: Date, tz: string) {
  // Events ending before 6 AM the next day count as same-night events.
  return formatEventDate(a, tz) === formatEventDate(new Date(b.getTime() - 6 * 3600_000), tz);
}

function tzLabel(tz: string) {
  return tz === "Africa/Nairobi" ? "EAT" : tz;
}

/**
 * Verification bot for outside resale tickets. Runs in the background when a
 * seller submits a ticket (and again when an admin corrects its details or
 * replaces its file), compares what the seller typed with what the uploaded
 * ticket and proof of purchase actually show, and looks for reused M-Pesa
 * codes and order numbers.
 *
 * It is advisory only: it labels a listing "passed" (green light for review)
 * or "flagged" with reasons. It never approves, rejects or changes a listing;
 * only an admin can, and the audit log records which admin did.
 *
 * It can't query other ticketing platforms (Mookh, Ticketsasa, …): none offer
 * a public API, so checks are limited to the documents and our own records.
 */
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { resaleDocuments, resaleListings, type ResaleListing } from "@/db/schema";
import { utcToZonedLocal } from "@/lib/dates";
import { userMessage } from "@/lib/errors";
import { formatMoney } from "@/lib/money";
import type { ResaleUpload } from "./documents";
import { scanConfig, scanReceipt, scanTicket, type ScannedReceipt, type ScannedTicket } from "./scan";

export type CheckItem = { label: string; status: "ok" | "warn" | "fail"; detail: string };
export type CheckResult = { items: CheckItem[]; ticket: ScannedTicket | null; receipt: ScannedReceipt | null };
export type CheckStatus = "pending" | "passed" | "flagged" | "error";

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

/** Share of the shorter name's words found in the other (0–1). */
export function nameSimilarity(a: string, b: string) {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

const squash = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase();

async function currentDocument(listingId: string, purpose: "ticket" | "proof"): Promise<ResaleUpload | null> {
  const [d] = await db
    .select()
    .from(resaleDocuments)
    .where(and(eq(resaleDocuments.listingId, listingId), eq(resaleDocuments.purpose, purpose), isNull(resaleDocuments.withdrawnAt)))
    .orderBy(desc(resaleDocuments.createdAt))
    .limit(1);
  return d ? { filename: d.filename, contentType: d.contentType, data: Buffer.from(d.data) } : null;
}

function ticketChecks(l: ResaleListing, t: ScannedTicket): CheckItem[] {
  const items: CheckItem[] = [];
  if (t.eventName && l.externalEventName) {
    const ok = nameSimilarity(t.eventName, l.externalEventName) >= 0.5;
    items.push({ label: "Event name", status: ok ? "ok" : "fail", detail: ok ? `Ticket shows “${t.eventName}”.` : `Ticket shows “${t.eventName}”, seller entered “${l.externalEventName}”.` });
  } else items.push({ label: "Event name", status: "warn", detail: "The event name couldn't be read from the ticket." });

  if (t.startsAtLocal && l.externalStartsAt) {
    const entered = utcToZonedLocal(l.externalStartsAt);
    const ok = t.startsAtLocal.slice(0, 10) === entered.slice(0, 10);
    items.push({ label: "Event date", status: ok ? "ok" : "fail", detail: ok ? `Ticket date matches (${entered.slice(0, 10)}).` : `Ticket shows ${t.startsAtLocal.replace("T", " ")}, seller entered ${entered.replace("T", " ")}.` });
  } else items.push({ label: "Event date", status: "warn", detail: "The date couldn't be read from the ticket." });

  if (t.venue && l.externalVenue) {
    const ok = nameSimilarity(t.venue, l.externalVenue) >= 0.5;
    items.push({ label: "Venue", status: ok ? "ok" : "warn", detail: ok ? `Ticket shows ${t.venue}.` : `Ticket shows “${t.venue}”, seller entered “${l.externalVenue}”.` });
  }
  if (t.ticketTypeName) {
    const ok = nameSimilarity(t.ticketTypeName, l.ticketTypeName) >= 0.5;
    items.push({ label: "Ticket type", status: ok ? "ok" : "warn", detail: ok ? `Ticket shows ${t.ticketTypeName}.` : `Ticket shows “${t.ticketTypeName}”, seller entered “${l.ticketTypeName}”.` });
  }
  if (t.orderRef && l.externalOrderRef) {
    const ok = squash(t.orderRef) === squash(l.externalOrderRef);
    items.push({ label: "Order number", status: ok ? "ok" : "fail", detail: ok ? `Matches the ticket (${t.orderRef}).` : `Ticket shows ${t.orderRef}, seller entered ${l.externalOrderRef}.` });
  }
  return items;
}

function receiptChecks(l: ResaleListing, r: ScannedReceipt): CheckItem[] {
  const items: CheckItem[] = [];
  const entered = l.externalMpesaCode;
  if (entered && r.mpesaCode) {
    const ok = r.mpesaCode === entered;
    items.push({ label: "M-Pesa code", status: ok ? "ok" : "fail", detail: ok ? `Matches the proof of purchase (${entered}).` : `Proof shows ${r.mpesaCode}, seller entered ${entered}.` });
  } else if (entered) {
    items.push({ label: "M-Pesa code", status: "warn", detail: `Seller entered ${entered}, but no M-Pesa code was found on the proof of purchase.` });
  } else {
    items.push({ label: "M-Pesa code", status: "warn", detail: r.mpesaCode ? `Seller didn't enter one; the proof shows ${r.mpesaCode}.` : "Seller didn't enter one and none was found on the proof of purchase." });
  }
  if (r.paidAtLocal && l.externalStartsAt) {
    const late = r.paidAtLocal > utcToZonedLocal(l.externalStartsAt);
    items.push({ label: "Payment date", status: late ? "fail" : "ok", detail: late ? `Paid ${r.paidAtLocal.replace("T", " ")}, after the event starts.` : `Paid ${r.paidAtLocal.replace("T", " ")}.` });
  }
  if (r.amountKes !== null && r.amountKes > 0) {
    const ratio = l.priceMinor / 100 / r.amountKes;
    items.push({
      label: "Amount paid",
      status: ratio > 3 ? "warn" : "ok",
      detail: `${formatMoney(r.amountKes * 100)} on the proof${ratio > 3 ? `; the asking price ${formatMoney(l.priceMinor)} is ${ratio.toFixed(1)}× that` : ""}${r.paidTo ? `, paid to ${r.paidTo}` : ""}.`,
    });
  }
  return items;
}

/** The same M-Pesa code or order number on another listing is a common scam. */
async function duplicateChecks(l: ResaleListing, receiptCode: string | null): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  const codes = [...new Set([l.externalMpesaCode, receiptCode].filter((c): c is string => !!c))];
  for (const code of codes) {
    const others = await db
      .select({ reference: resaleListings.reference })
      .from(resaleListings)
      .where(and(ne(resaleListings.id, l.id), eq(resaleListings.externalMpesaCode, code)));
    items.push(
      others.length
        ? { label: "M-Pesa code reuse", status: "fail", detail: `${code} is also on ${others.map((o) => o.reference).join(", ")}.` }
        : { label: "M-Pesa code reuse", status: "ok", detail: `${code} isn't on any other listing.` },
    );
  }
  if (l.externalOrderRef) {
    const others = await db
      .select({ reference: resaleListings.reference })
      .from(resaleListings)
      .where(and(ne(resaleListings.id, l.id), sql`upper(regexp_replace(${resaleListings.externalOrderRef}, '[^A-Za-z0-9]', '', 'g')) = ${squash(l.externalOrderRef)}`));
    if (others.length) items.push({ label: "Order number reuse", status: "fail", detail: `${l.externalOrderRef} is also on ${others.map((o) => o.reference).join(", ")}.` });
  }
  return items;
}

/** Runs every check and stores the result on the listing. */
export async function verifyExternalListing(listingId: string): Promise<CheckStatus | null> {
  const [l] = await db.select().from(resaleListings).where(eq(resaleListings.id, listingId));
  if (!l || l.kind !== "external") return null;

  const items: CheckItem[] = [];
  let ticket: ScannedTicket | null = null;
  let receipt: ScannedReceipt | null = null;

  if (l.externalStartsAt && l.externalStartsAt <= new Date()) items.push({ label: "Event date", status: "fail", detail: "The event has already started." });

  const readerReady = scanConfig() !== null;
  const ticketFile = await currentDocument(l.id, "ticket");
  if (!ticketFile) items.push({ label: "Ticket file", status: "fail", detail: "No ticket file is attached." });
  else if (!readerReady) items.push({ label: "Ticket file", status: "warn", detail: "The document reader isn't set up, so the ticket wasn't read. Check it by hand." });
  else {
    try {
      ticket = await scanTicket(ticketFile);
      items.push(...ticketChecks(l, ticket));
    } catch (err) {
      items.push({ label: "Ticket file", status: "warn", detail: `The ticket couldn't be read: ${userMessage(err)}` });
    }
  }

  const proofFile = await currentDocument(l.id, "proof");
  if (!proofFile) items.push({ label: "Proof of purchase", status: "fail", detail: "No proof of purchase is attached." });
  else if (!readerReady) items.push({ label: "Proof of purchase", status: "warn", detail: "The document reader isn't set up, so the proof wasn't read. Check it by hand." });
  else {
    try {
      receipt = await scanReceipt(proofFile);
      items.push(...receiptChecks(l, receipt));
    } catch (err) {
      items.push({ label: "Proof of purchase", status: "warn", detail: `The proof couldn't be read: ${userMessage(err)}` });
    }
  }
  if (!readerReady && !l.externalMpesaCode) items.push({ label: "M-Pesa code", status: "warn", detail: "Seller didn't enter one." });

  items.push(...(await duplicateChecks(l, receipt?.mpesaCode ?? null)));

  const status: CheckStatus = items.every((i) => i.status === "ok") ? "passed" : "flagged";
  const result: CheckResult = { items, ticket, receipt };
  await db.update(resaleListings).set({ checkStatus: status, checkResult: result, checkedAt: new Date() }).where(eq(resaleListings.id, l.id));
  return status;
}

/** Marks the check as failed after the job gave up (shown to admins as "couldn't run"). */
export async function markVerificationError(listingId: string, message: string) {
  await db
    .update(resaleListings)
    .set({ checkStatus: "error", checkResult: { items: [{ label: "Checks", status: "warn", detail: message.slice(0, 300) }], ticket: null, receipt: null } satisfies CheckResult, checkedAt: new Date() })
    .where(eq(resaleListings.id, listingId));
}

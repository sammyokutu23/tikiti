/**
 * "Scan ticket details": reads an uploaded outside ticket (PDF or image) with an
 * OpenAI vision model and returns the fields the seller would otherwise type.
 * The seller always reviews the result before submitting, and admins review
 * the listing, so a wrong guess costs nothing but a correction.
 *
 * Server-only: the key never leaves the server and the raw provider response
 * is never forwarded to the browser.
 */
import OpenAI from "openai";
import { z } from "zod";
import { UserError } from "@/lib/errors";
import type { ResaleUpload } from "./documents";

export type ScanConfig = { apiKey: string; model: string };

export function scanConfig(source: Record<string, string | undefined> = process.env): ScanConfig | null {
  const apiKey = source.OPENAI_API_KEY?.trim();
  const model = source.OPENAI_SCAN_MODEL?.trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

export const scannedTicketSchema = z.object({
  eventName: z.string().max(160).nullable(),
  venue: z.string().max(160).nullable(),
  city: z.string().max(80).nullable(),
  /** Local Nairobi time as YYYY-MM-DDTHH:mm, for a datetime-local input. */
  startsAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable().catch(null),
  ticketTypeName: z.string().max(80).nullable(),
  platform: z.string().max(80).nullable(),
  orderRef: z.string().max(120).nullable(),
});
export type ScannedTicket = z.infer<typeof scannedTicketSchema>;

const nullableString = { type: ["string", "null"] };
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["eventName", "venue", "city", "startsAtLocal", "ticketTypeName", "platform", "orderRef"],
  properties: {
    eventName: { ...nullableString, description: "Name of the event" },
    venue: { ...nullableString, description: "Venue name, without the city" },
    city: { ...nullableString, description: "City or town, e.g. Nairobi" },
    startsAtLocal: { ...nullableString, description: "Event start in local Kenyan time, formatted YYYY-MM-DDTHH:mm" },
    ticketTypeName: { ...nullableString, description: "Ticket tier, e.g. Regular, VIP, Early Bird" },
    platform: { ...nullableString, description: "Who sold the ticket, e.g. Mookh, Ticketsasa, or the organizer's name" },
    orderRef: { ...nullableString, description: "Order, booking or ticket number printed on the ticket" },
  },
};

const INSTRUCTIONS =
  "You read event tickets sold in Kenya. Extract only what is printed on the ticket. " +
  "Use null for anything that isn't clearly shown; never guess. Times are East Africa Time.";

/** The provider call, swappable in tests. */
export type TicketReader = (cfg: ScanConfig, file: ResaleUpload) => Promise<string>;

/** Sends one document to the vision model and returns its JSON answer as text. */
async function readWithOpenAi(cfg: ScanConfig, file: ResaleUpload, ask: { name: string; schema: Record<string, unknown>; instructions: string; prompt: string }) {
  const client = new OpenAI({ apiKey: cfg.apiKey, timeout: 60_000, maxRetries: 1 });
  const dataUrl = `data:${file.contentType};base64,${file.data.toString("base64")}`;
  const res = await client.responses.create({
    model: cfg.model,
    instructions: ask.instructions,
    input: [
      {
        role: "user",
        content: [
          file.contentType === "application/pdf"
            ? { type: "input_file", filename: file.filename, file_data: dataUrl }
            : { type: "input_image", image_url: dataUrl, detail: "high" },
          { type: "input_text", text: ask.prompt },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: ask.name, strict: true, schema: ask.schema } },
  });
  return res.output_text;
}

const openAiReader: TicketReader = (cfg, file) =>
  readWithOpenAi(cfg, file, { name: "ticket_details", schema: JSON_SCHEMA, instructions: INSTRUCTIONS, prompt: "Extract the ticket details." });

let readerOverride: TicketReader | null = null;
export function setTicketReaderOverride(fn: TicketReader | null) {
  readerOverride = fn;
}

export async function scanTicket(file: ResaleUpload, cfg = scanConfig()): Promise<ScannedTicket> {
  if (!cfg) throw new UserError("Ticket scanning isn't available right now. Please fill in the details yourself.");
  let raw: string;
  try {
    raw = await (readerOverride ?? openAiReader)(cfg, file);
  } catch (err) {
    console.error("[resale-scan] provider error", (err as Error)?.name);
    throw new UserError("We couldn't read your ticket right now. Please fill in the details yourself.");
  }
  let parsed: ScannedTicket | null = null;
  try {
    const r = scannedTicketSchema.safeParse(JSON.parse(raw));
    if (r.success) parsed = r.data;
  } catch {
    // fall through
  }
  if (!parsed) throw new UserError("We couldn't read your ticket. Please fill in the details yourself.");
  const clean = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? v.trim() || null : null])) as ScannedTicket;
  if (Object.values(clean).every((v) => v === null)) {
    throw new UserError("We couldn't find any ticket details in that file. Check it's the right file, or fill in the details yourself.");
  }
  return clean;
}

// ─── Proof of purchase (used by the verification bot) ────────────────────────

export const scannedReceiptSchema = z.object({
  mpesaCode: z.string().max(20).nullable(),
  amountKes: z.number().nonnegative().nullable().catch(null),
  /** Local Nairobi time as YYYY-MM-DDTHH:mm. */
  paidAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).nullable().catch(null),
  paidTo: z.string().max(160).nullable(),
});
export type ScannedReceipt = z.infer<typeof scannedReceiptSchema>;

const RECEIPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["mpesaCode", "amountKes", "paidAtLocal", "paidTo"],
  properties: {
    mpesaCode: { ...nullableString, description: "M-Pesa transaction/confirmation code, usually 10 capital letters and digits, e.g. SJK3H7QX2P" },
    amountKes: { type: ["number", "null"], description: "Amount paid in Kenyan shillings" },
    paidAtLocal: { ...nullableString, description: "When the payment was made, local Kenyan time, formatted YYYY-MM-DDTHH:mm" },
    paidTo: { ...nullableString, description: "Who was paid: merchant, paybill/till name or ticketing platform" },
  },
};

const RECEIPT_INSTRUCTIONS =
  "You read proof-of-purchase documents for event tickets bought in Kenya: M-Pesa confirmation messages or screenshots, " +
  "order emails and receipts. Extract only what is shown; use null for anything that isn't clearly shown; never guess.";

/** The receipt reader, swappable in tests. */
export type ReceiptReader = (cfg: ScanConfig, file: ResaleUpload) => Promise<string>;
const openAiReceiptReader: ReceiptReader = (cfg, file) =>
  readWithOpenAi(cfg, file, { name: "receipt_details", schema: RECEIPT_SCHEMA, instructions: RECEIPT_INSTRUCTIONS, prompt: "Extract the payment details." });

let receiptReaderOverride: ReceiptReader | null = null;
export function setReceiptReaderOverride(fn: ReceiptReader | null) {
  receiptReaderOverride = fn;
}

/** Reads a proof of purchase. Throws UserError when it can't. */
export async function scanReceipt(file: ResaleUpload, cfg = scanConfig()): Promise<ScannedReceipt> {
  if (!cfg) throw new UserError("The document reader isn't set up (OPENAI_SCAN_MODEL).");
  let raw: string;
  try {
    raw = await (receiptReaderOverride ?? openAiReceiptReader)(cfg, file);
  } catch (err) {
    console.error("[resale-scan] receipt provider error", (err as Error)?.name);
    throw new UserError("The document reader couldn't be reached.");
  }
  try {
    const r = scannedReceiptSchema.safeParse(JSON.parse(raw));
    if (r.success) return { ...r.data, mpesaCode: r.data.mpesaCode?.replace(/\s+/g, "").toUpperCase() || null, paidTo: r.data.paidTo?.trim() || null };
  } catch {
    // fall through
  }
  throw new UserError("The proof of purchase couldn't be read.");
}

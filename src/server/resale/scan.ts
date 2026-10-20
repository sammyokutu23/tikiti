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

const openAiReader: TicketReader = async (cfg, file) => {
  const client = new OpenAI({ apiKey: cfg.apiKey, timeout: 60_000, maxRetries: 1 });
  const dataUrl = `data:${file.contentType};base64,${file.data.toString("base64")}`;
  const res = await client.responses.create({
    model: cfg.model,
    instructions: INSTRUCTIONS,
    input: [
      {
        role: "user",
        content: [
          file.contentType === "application/pdf"
            ? { type: "input_file", filename: file.filename, file_data: dataUrl }
            : { type: "input_image", image_url: dataUrl, detail: "high" },
          { type: "input_text", text: "Extract the ticket details." },
        ],
      },
    ],
    text: { format: { type: "json_schema", name: "ticket_details", strict: true, schema: JSON_SCHEMA } },
  });
  return res.output_text;
};

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

import { UserError } from "@/lib/errors";
import { sniffImage } from "../storage";

/** Two files must fit in one request (Vercel caps bodies at 4.5 MB). */
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;

export type ResaleUpload = { filename: string; contentType: string; data: Buffer };

/** Accepts a ticket or receipt as JPG, PNG, WebP or PDF, identified by its bytes (never the declared type). */
export async function readResaleUpload(file: FormDataEntryValue | null, label: string): Promise<ResaleUpload> {
  if (!(file instanceof File) || file.size === 0) throw new UserError(`Attach the ${label}.`);
  if (file.size > MAX_DOCUMENT_BYTES) throw new UserError(`The ${label} is too large. Maximum size is 2 MB.`);
  const data = Buffer.from(await file.arrayBuffer());
  const image = sniffImage(data);
  const isPdf = data.subarray(0, 5).toString("latin1") === "%PDF-";
  if (!image && !isPdf) throw new UserError(`The ${label} must be a PDF, JPG, PNG or WebP file.`);
  const ext = image ? image.ext : "pdf";
  const base = file.name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || label.replace(/\s+/g, "-");
  return { filename: `${base}.${ext}`, contentType: image ? image.mime : "application/pdf", data };
}

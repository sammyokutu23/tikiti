/**
 * Object storage adapter for event images.
 *  - local: ./storage/uploads, served by /media/[...key]. Dev only — most hosts
 *    have ephemeral disks. Production should set STORAGE_DRIVER=s3 and implement
 *    the S3/R2 adapter below (same interface).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomToken } from "@/lib/crypto";
import { UserError } from "@/lib/errors";

export const UPLOAD_DIR = path.resolve(process.cwd(), "storage/uploads");
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1024;

export type ImageKind = { ext: "jpg" | "png" | "webp"; mime: string };

/** Identify an image by its magic bytes (never trust the declared MIME type). */
export function sniffImage(buf: Uint8Array): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (
    buf.length >= 12 &&
    String.fromCharCode(...buf.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...buf.subarray(8, 12)) === "WEBP"
  )
    return { ext: "webp", mime: "image/webp" };
  return null;
}

export function validateImageUpload(buf: Uint8Array): ImageKind {
  if (buf.length > MAX_IMAGE_BYTES) throw new UserError("Image is too large. Maximum size is 5 MB.");
  if (buf.length < MIN_IMAGE_BYTES) throw new UserError("Image file is empty or corrupt.");
  const kind = sniffImage(buf);
  if (!kind) throw new UserError("Unsupported image. Upload a JPG, PNG or WebP file.");
  return kind;
}

export interface StorageDriver {
  put(buf: Uint8Array, kind: ImageKind, prefix: string): Promise<string>; // returns public URL
}

const local: StorageDriver = {
  async put(buf, kind, prefix) {
    const key = `${prefix}/${Date.now()}-${randomToken(9)}.${kind.ext}`;
    const full = path.join(UPLOAD_DIR, key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, buf);
    return `/media/${key}`;
  },
};

export function storage(): StorageDriver {
  const driver = process.env.STORAGE_DRIVER ?? "local";
  if (driver === "local") return local;
  throw new Error(`STORAGE_DRIVER=${driver} is not implemented yet. See docs/PRODUCTION.md.`);
}

export async function saveEventImage(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new UserError("Image is too large. Maximum size is 5 MB.");
  const buf = new Uint8Array(await file.arrayBuffer());
  const kind = validateImageUpload(buf);
  return storage().put(buf, kind, "events");
}

/** Resolve a key under UPLOAD_DIR safely (no path traversal). */
export function resolveLocalMedia(key: string): string | null {
  const full = path.resolve(UPLOAD_DIR, key);
  return full.startsWith(UPLOAD_DIR + path.sep) ? full : null;
}

const imageCache = new Map<string, Uint8Array>();

/** Fetch image bytes for PDF rendering (local media or remote HTTPS). */
export async function loadImageBytes(url: string): Promise<Uint8Array | null> {
  if (imageCache.has(url)) return imageCache.get(url)!;
  let bytes: Uint8Array | null = null;
  if (url.startsWith("/media/")) {
    const p = resolveLocalMedia(decodeURIComponent(url.slice("/media/".length)));
    if (p) bytes = new Uint8Array(await fs.readFile(p).catch(() => Buffer.alloc(0)));
  } else if (/^https:\/\//.test(url)) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const u = new URL(url);
      if (u.hostname === "images.unsplash.com") {
        u.searchParams.delete("auto"); // auto=format may negotiate AVIF/WebP, which pdf-lib can't embed
        u.searchParams.set("fm", "jpg");
        u.searchParams.set("w", "1200");
        u.searchParams.set("q", "75");
      }
      const res = await fetch(u, { signal: ctrl.signal });
      if (res.ok) bytes = new Uint8Array(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
  if (!bytes || bytes.length === 0 || bytes.length > 8 * 1024 * 1024) return null;
  if (imageCache.size > 30) imageCache.delete(imageCache.keys().next().value!);
  imageCache.set(url, bytes);
  return bytes;
}

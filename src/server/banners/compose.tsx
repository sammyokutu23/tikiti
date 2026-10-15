/**
 * Banner composition: crops the AI background to the output format (sharp) and
 * overlays the real event details with our own typography (next/og → satori).
 * Every string comes from the event row on the server, never from the browser.
 *
 * Text stays inside a safe area: for the 16:9 website banner the text block sits
 * above the bottom 12% so the 16:7 and 16:10 crops used across the site keep it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import sharp, { type OverlayOptions } from "sharp";
import { formatEventDate, formatTime } from "@/lib/dates";
import { BANNER_FORMATS, type BannerFormat } from "./prompt";

export type BannerOverlay = {
  title: string;
  startsAt: Date;
  timezone: string;
  venue: string;
  organizerName: string | null;
  showDate: boolean;
  showVenue: boolean;
  showCta: boolean;
  showOrganizer: boolean;
  /** false = clean artwork without any text. */
  showText: boolean;
};

type FontSpec = { name: string; data: ArrayBuffer; weight: 500 | 700 | 800; style: "normal" };
let fontsPromise: Promise<FontSpec[]> | null = null;
function fonts() {
  // Bundled with the app (assets/fonts, traced via outputFileTracingIncludes); read once per process.
  fontsPromise ??= Promise.all(
    ([500, 700, 800] as const).map(async (weight) => {
      const buf = await readFile(join(process.cwd(), "assets/fonts", `geist-sans-latin-${weight}-normal.woff`));
      return { name: "Geist", data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, weight, style: "normal" as const };
    }),
  );
  return fontsPromise;
}

function titleSize(title: string, width: number, format: BannerFormat) {
  const base = width * (format === "landscape" ? 0.058 : 0.085);
  const len = title.length;
  if (len <= 18) return Math.round(base * 1.15);
  if (len <= 32) return Math.round(base);
  if (len <= 56) return Math.round(base * 0.8);
  return Math.round(base * 0.64);
}

function Overlay({ o, format, width, height }: { o: BannerOverlay; format: BannerFormat; width: number; height: number }) {
  const pad = Math.round(width * (format === "landscape" ? 0.06 : 0.067));
  // Landscape: keep 12% clear at the bottom (16:7 crops remove ~11%).
  const bottom = Math.round(height * (format === "landscape" ? 0.14 : 0.075));
  const small = Math.round(width * (format === "landscape" ? 0.017 : 0.028));
  const meta = Math.round(width * (format === "landscape" ? 0.021 : 0.034));
  const title = o.title.length > 90 ? `${o.title.slice(0, 87)}…` : o.title;
  const when = `${formatEventDate(o.startsAt, o.timezone)} · ${formatTime(o.startsAt, o.timezone)}`;
  return (
    <div style={{ width, height, display: "flex", position: "relative", fontFamily: "Geist", color: "white" }}>
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width,
          height,
          display: "flex",
          backgroundImage:
            format === "landscape"
              ? "linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.6) 38%, rgba(0,0,0,0.05) 72%, rgba(0,0,0,0) 100%)"
              : "linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.6) 35%, rgba(0,0,0,0) 62%)",
        }}
      />
      {o.showOrganizer && o.organizerName && (
        <div
          style={{
            position: "absolute",
            top: Math.round(height * (format === "landscape" ? 0.13 : 0.06)),
            left: pad,
            display: "flex",
            fontSize: small,
            fontWeight: 700,
            letterSpacing: small * 0.12,
            textTransform: "uppercase",
            padding: `${Math.round(small * 0.5)}px ${Math.round(small * 0.9)}px`,
            borderRadius: 999,
            backgroundColor: "rgba(0,0,0,0.45)",
          }}
        >
          {o.organizerName.slice(0, 48)}
        </div>
      )}
      <div style={{ position: "absolute", left: pad, right: pad, bottom, display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            fontSize: titleSize(title, width, format),
            fontWeight: 800,
            lineHeight: 1.04,
            letterSpacing: -titleSize(title, width, format) * 0.02,
            maxWidth: format === "landscape" ? width * 0.72 : width - pad * 2,
            textShadow: "0 2px 18px rgba(0,0,0,0.45)",
          }}
        >
          {title}
        </div>
        {(o.showDate || o.showVenue) && (
          <div style={{ display: "flex", flexDirection: "column", marginTop: Math.round(meta * 0.9), fontSize: meta, fontWeight: 500, lineHeight: 1.35, opacity: 0.95 }}>
            {o.showDate && <div style={{ display: "flex" }}>{when}</div>}
            {o.showVenue && o.venue && <div style={{ display: "flex", opacity: 0.88 }}>{o.venue.slice(0, 80)}</div>}
          </div>
        )}
        {o.showCta && (
          <div style={{ display: "flex", marginTop: Math.round(meta * 1.1) }}>
            <div
              style={{
                display: "flex",
                fontSize: Math.round(meta * 0.85),
                fontWeight: 700,
                color: "#0b0b0d",
                backgroundColor: "white",
                borderRadius: 999,
                padding: `${Math.round(meta * 0.45)}px ${Math.round(meta * 1.1)}px`,
              }}
            >
              Get tickets on Tikiti
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export async function composeBanner(background: Uint8Array, format: BannerFormat, overlay: BannerOverlay): Promise<Uint8Array> {
  const { width, height } = BANNER_FORMATS[format];
  const base = sharp(Buffer.from(background), { limitInputPixels: 40_000_000 }).rotate().resize(width, height, { fit: "cover", position: "attention" });
  const layers: OverlayOptions[] = [];
  if (overlay.showText) {
    const res = new ImageResponse(<Overlay o={overlay} format={format} width={width} height={height} />, { width, height, fonts: await fonts() });
    layers.push({ input: Buffer.from(await res.arrayBuffer()) });
  }
  const out = await base.composite(layers).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  return new Uint8Array(out);
}

/** Normalises provider output for storage: strips metadata, caps size, re-encodes as JPEG. */
export async function normalizeBackground(bytes: Uint8Array): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const img = sharp(Buffer.from(bytes), { limitInputPixels: 40_000_000 }).rotate();
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("Unreadable image");
  const out = await img.resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(out.data), width: out.info.width, height: out.info.height };
}

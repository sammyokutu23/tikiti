import { describe, expect, it } from "vitest";
import { calculateCommission, formatMoney, parseMajorToMinor } from "@/lib/money";
import { normalizeKenyanPhone } from "@/lib/utils";
import { utcToZonedLocal, zonedLocalToUtc } from "@/lib/dates";
import { buildQrPayload, parseScanInput } from "@/server/tickets/qr";
import { sniffImage, validateImageUpload, MAX_IMAGE_BYTES } from "@/server/storage";
import { createBookingAccessToken, verifyBookingAccessToken } from "@/server/bookings/access";

describe("money & commission", () => {
  it("calculates 5% commission with half-up rounding in minor units", () => {
    expect(calculateCommission(250_000, 500)).toBe(12_500); // KES 2,500 → KES 125
    expect(calculateCommission(10, 500)).toBe(1); // 0.5 → 1
    expect(calculateCommission(9, 500)).toBe(0); // 0.45 → 0
    expect(calculateCommission(0, 500)).toBe(0);
    expect(calculateCommission(100_000, 0)).toBe(0);
  });
  it("parses KES amounts to minor units", () => {
    expect(parseMajorToMinor("1,500")).toBe(150_000);
    expect(parseMajorToMinor("1500.5")).toBe(150_050);
    expect(parseMajorToMinor("abc")).toBeNull();
    expect(parseMajorToMinor("-5")).toBeNull();
  });
  it("formats KES", () => {
    expect(formatMoney(250_000)).toBe("KES 2,500");
    expect(formatMoney(0)).toBe("Free");
  });
});

describe("phone & dates", () => {
  it("normalises Kenyan numbers", () => {
    expect(normalizeKenyanPhone("0712 345 678")).toBe("254712345678");
    expect(normalizeKenyanPhone("+254 112 345 678")).toBe("254112345678");
    expect(normalizeKenyanPhone("12345")).toBeNull();
  });
  it("converts Nairobi wall-clock to UTC and back", () => {
    const d = zonedLocalToUtc("2026-11-07T20:30", "Africa/Nairobi")!;
    expect(d.toISOString()).toBe("2026-11-07T17:30:00.000Z");
    expect(utcToZonedLocal(d, "Africa/Nairobi")).toBe("2026-11-07T20:30");
  });
});

describe("QR payloads", () => {
  const code = "K7QM-2XPA-9DRT-HWZB";
  it("round-trips a signed payload without personal data", () => {
    const p = buildQrPayload(code);
    expect(p).toMatch(/^TKT1\.K7QM-2XPA-9DRT-HWZB\.[A-Za-z0-9_-]+$/);
    expect(parseScanInput(p)).toEqual({ ok: true, code, source: "qr" });
  });
  it("rejects tampered payloads", () => {
    const p = buildQrPayload(code);
    const forged = p.replace("K7QM", "K7QN");
    expect(parseScanInput(forged)).toEqual({ ok: false, reason: "bad_signature" });
    expect(parseScanInput("TKT1.garbage")).toEqual({ ok: false, reason: "malformed" });
  });
  it("accepts manually typed codes in any case/spacing", () => {
    expect(parseScanInput("k7qm 2xpa 9drt hwzb")).toEqual({ ok: true, code, source: "manual" });
  });
});

describe("guest access links", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  it("only unlocks the booking it was issued for", () => {
    const t = createBookingAccessToken(id, new Date(Date.now() + 86_400_000));
    expect(verifyBookingAccessToken(t, id)).toBe(true);
    expect(verifyBookingAccessToken(t, other)).toBe(false);
    expect(verifyBookingAccessToken(t.slice(0, -2) + "xx", id)).toBe(false);
    expect(verifyBookingAccessToken(null, id)).toBe(false);
  });
  it("expires", () => {
    const t = createBookingAccessToken(id, new Date(Date.now() - 100 * 86_400_000));
    expect(verifyBookingAccessToken(t, id, new Date(Date.now() + 8 * 86_400_000))).toBe(false);
  });
});

describe("image upload validation", () => {
  const png = new Uint8Array(2048);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  it("sniffs real image types by magic bytes", () => {
    expect(sniffImage(png)?.ext).toBe("png");
    expect(validateImageUpload(png).mime).toBe("image/png");
  });
  it("rejects SVG/HTML disguised as images, tiny and oversized files", () => {
    const svg = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`.padEnd(2048, " "));
    expect(() => validateImageUpload(svg)).toThrow(/Unsupported image/);
    expect(() => validateImageUpload(new Uint8Array(10))).toThrow(/empty or corrupt/);
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(() => validateImageUpload(big)).toThrow(/too large/);
  });
});

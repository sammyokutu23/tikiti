/** Returns a right-sized URL for event images (Unsplash supports on-the-fly resizing). */
export function eventImageSrc(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  if (url.startsWith("https://images.unsplash.com/")) {
    try {
      const u = new URL(url);
      u.searchParams.set("w", String(width));
      u.searchParams.set("q", "75");
      u.searchParams.set("auto", "format");
      u.searchParams.set("fit", "crop");
      return u.toString();
    } catch {
      return url;
    }
  }
  return url;
}

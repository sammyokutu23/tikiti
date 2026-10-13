import fs from "node:fs/promises";
import { resolveLocalMedia, sniffImage } from "@/server/storage";

/** Serves locally stored uploads (dev storage driver). */
export async function GET(_req: Request, ctx: RouteContext<"/media/[...key]">) {
  const { key } = await ctx.params;
  const p = resolveLocalMedia(key.map(decodeURIComponent).join("/"));
  if (!p) return new Response("Not found", { status: 404 });
  try {
    const buf = await fs.readFile(p);
    const kind = sniffImage(buf);
    if (!kind) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": kind.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

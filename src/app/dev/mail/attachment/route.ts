import fs from "node:fs/promises";
import path from "node:path";
import { MAIL_DIR } from "@/server/email/transport";

export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") return new Response("Not found", { status: 404 });
  const u = new URL(req.url);
  const id = u.searchParams.get("id") ?? "";
  const i = Number(u.searchParams.get("i") ?? 0);
  if (!/^[\w-]+$/.test(id) || !Number.isInteger(i)) return new Response("Bad request", { status: 400 });
  try {
    const meta = JSON.parse(await fs.readFile(path.join(MAIL_DIR, `${id}.json`), "utf8"));
    const buf = await fs.readFile(path.join(MAIL_DIR, `${id}.att${i}`));
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${meta.attachments[i].filename}"` },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

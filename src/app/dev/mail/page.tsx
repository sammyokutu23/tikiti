import fs from "node:fs/promises";
import path from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Inbox, Paperclip } from "lucide-react";
import { EmptyState } from "@/components/ui";
import { MAIL_DIR } from "@/server/email/transport";

export const metadata = { title: "Dev mailbox", robots: { index: false } };

type Captured = { id: string; to: string; subject: string; html: string; capturedAt: string; attachments: { filename: string; size: number }[] };

/** Local preview of emails captured by EMAIL_TRANSPORT=dev-capture. Disabled in production. */
export default async function DevMailPage({ searchParams }: PageProps<"/dev/mail">) {
  if (process.env.NODE_ENV === "production") notFound();
  const { id } = await searchParams;
  const files = (await fs.readdir(MAIL_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, 100);
  const mails: Captured[] = await Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(MAIL_DIR, f), "utf8"))));
  const selected = mails.find((m) => m.id === id) ?? mails[0];

  return (
    <main className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-3">
        <h1 className="text-xl font-bold">Dev mailbox</h1>
        <p className="text-xs text-muted">Emails captured locally — nothing here was delivered. Configure SMTP_URL to send real email.</p>
        {mails.length === 0 && <EmptyState icon={<Inbox className="size-6" />} title="No emails yet" />}
        <ul className="space-y-2">
          {mails.map((m) => (
            <li key={m.id}>
              <Link href={`/dev/mail?id=${m.id}`} className={`block rounded-2xl border p-3 text-sm ${m.id === selected?.id ? "border-white/40 bg-white/8" : "border-line hover:bg-white/4"}`}>
                <p className="truncate font-medium">{m.subject}</p>
                <p className="truncate text-xs text-muted">{m.to} · {new Date(m.capturedAt).toLocaleString("en-KE")}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {selected && (
        <div className="space-y-3">
          <div className="text-sm">
            <p><span className="text-muted">To:</span> {selected.to}</p>
            <p><span className="text-muted">Subject:</span> {selected.subject}</p>
            {selected.attachments.map((a, i) => (
              <a key={a.filename} href={`/dev/mail/attachment?id=${selected.id}&i=${i}`} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/8 px-3 py-1 text-xs hover:bg-white/14">
                <Paperclip className="size-3.5" /> {a.filename} ({Math.round(a.size / 1024)} KB)
              </a>
            ))}
          </div>
          <iframe title="Email preview" sandbox="" srcDoc={selected.html} className="h-[75vh] w-full rounded-2xl border border-line bg-white" />
        </div>
      )}
    </main>
  );
}

/**
 * Email transport adapter.
 *  - dev-capture: writes the full MIME message to ./storage/mail and records it as
 *    "captured" (viewable at /dev/mail). It is never reported as delivered.
 *  - resend: Resend API (recommended for production). See ./resend.ts and docs/EMAIL.md.
 *  - smtp: real delivery via SMTP_URL (any transactional provider or Mailpit).
 *  - disabled: every send fails honestly with "no email transport configured".
 */
import fs from "node:fs/promises";
import path from "node:path";
import nodemailer from "nodemailer";
import { env } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import { resendConfig, sendWithResend } from "./resend";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  /** Stable per delivery; providers that support it (Resend) dedupe retries with it. */
  idempotencyKey?: string;
  /** Non-sensitive labels for the provider dashboard (kind, delivery id). */
  tags?: Record<string, string>;
};

/** sent = handed to SMTP; accepted = provider queued it (delivery confirmed later by webhook); captured = dev only. */
export type SendResult = { status: "sent" | "captured" | "accepted"; messageId: string; transport: string };

export interface EmailTransport {
  name: string;
  send(msg: OutgoingEmail): Promise<SendResult>;
}

export const MAIL_DIR = path.resolve(process.cwd(), "storage/mail");

const devCapture: EmailTransport = {
  name: "dev-capture",
  async send(msg) {
    const id = `${Date.now()}-${randomToken(6)}`;
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    const info = await builder.sendMail({ from: env.emailFrom, replyTo: env.emailReplyTo, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, attachments: msg.attachments });
    await fs.mkdir(MAIL_DIR, { recursive: true });
    await fs.writeFile(path.join(MAIL_DIR, `${id}.eml`), info.message as Buffer);
    await fs.writeFile(
      path.join(MAIL_DIR, `${id}.json`),
      JSON.stringify(
        {
          id,
          to: msg.to,
          from: env.emailFrom,
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, size: a.content.length })),
          capturedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    for (const [i, a] of (msg.attachments ?? []).entries()) {
      await fs.writeFile(path.join(MAIL_DIR, `${id}.att${i}`), a.content);
    }
    return { status: "captured", messageId: id, transport: "dev-capture" };
  },
};

function smtp(): EmailTransport {
  if (!env.smtpUrl) throw new Error("EMAIL_TRANSPORT=smtp but SMTP_URL is empty");
  const t = nodemailer.createTransport(env.smtpUrl);
  return {
    name: "smtp",
    async send(msg) {
      const info = await t.sendMail({ from: env.emailFrom, replyTo: env.emailReplyTo, to: msg.to, subject: msg.subject, html: msg.html, text: msg.text, attachments: msg.attachments });
      return { status: "sent", messageId: info.messageId, transport: "smtp" };
    },
  };
}

function resend(): EmailTransport {
  const cfg = resendConfig(); // throws EmailConfigError with a useful message
  return {
    name: "resend",
    async send(msg) {
      const { id } = await sendWithResend(cfg, {
        ...msg,
        idempotencyKey: msg.idempotencyKey ?? `tikiti-adhoc-${randomToken(12)}`,
      });
      return { status: "accepted", messageId: id, transport: "resend" };
    },
  };
}

const disabled: EmailTransport = {
  name: "disabled",
  async send() {
    throw new Error("No email transport configured (EMAIL_TRANSPORT=disabled)");
  },
};

let override: EmailTransport | null = null;
/** Test hook: replace the transport (e.g. with a failing one). */
export function setEmailTransportOverride(t: EmailTransport | null) {
  override = t;
}

export function getEmailTransport(): EmailTransport {
  if (override) return override;
  switch (env.emailTransport) {
    case "resend":
      return resend();
    case "smtp":
      return smtp();
    case "disabled":
      return disabled;
    default:
      return devCapture;
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === "change-me") {
    throw new Error(`Environment variable ${name} is missing. See .env.example.`);
  }
  return v;
}

export const env = {
  get appUrl() {
    // APP_BASE_URL is the documented name; APP_URL is kept for existing deployments.
    return (process.env.APP_BASE_URL || process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  },
  get sessionSecret() {
    return required("SESSION_SECRET");
  },
  get qrSigningSecret() {
    return required("QR_SIGNING_SECRET");
  },
  get accessLinkSecret() {
    return required("ACCESS_LINK_SECRET");
  },
  get mockWebhookSecret() {
    return required("MOCK_PAYMENT_WEBHOOK_SECRET");
  },
  get paymentProvider() {
    return process.env.PAYMENT_PROVIDER ?? "mock";
  },
  /** Provider for M-Pesa: "mock" (simulated) or "daraja" (Safaricom STK Push). */
  get mpesaProvider() {
    return process.env.MPESA_PROVIDER || this.paymentProvider;
  },
  /**
   * Provider for cards: "mock" or "disabled". Defaults to the simulator, except
   * when live M-Pesa is configured — simulated cards must never sit beside real payments.
   */
  get cardProvider() {
    if (process.env.CARD_PROVIDER) return process.env.CARD_PROVIDER;
    if (this.mpesaProvider === "daraja" && process.env.DARAJA_ENV === "production") return "disabled";
    return this.paymentProvider === "daraja" ? "mock" : this.paymentProvider;
  },
  get emailTransport() {
    return (process.env.EMAIL_TRANSPORT ?? "dev-capture") as "dev-capture" | "smtp" | "resend" | "disabled";
  },
  get smtpUrl() {
    return process.env.SMTP_URL ?? "";
  },
  /** Sender for every transport. RESEND_FROM_EMAIL/RESEND_FROM_NAME win over the legacy EMAIL_FROM. */
  get emailFrom() {
    const email = process.env.RESEND_FROM_EMAIL?.trim();
    if (email) {
      const name = (process.env.RESEND_FROM_NAME ?? "").replace(/["<>\r\n\\]/g, "").trim();
      return name ? `"${name}" <${email}>` : email;
    }
    return process.env.EMAIL_FROM ?? "TikoSoko <tickets@example.com>";
  },
  get emailReplyTo() {
    return process.env.RESEND_REPLY_TO?.trim() || this.supportEmail;
  },
  get supportEmail() {
    return process.env.SUPPORT_EMAIL ?? "support@example.com";
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};

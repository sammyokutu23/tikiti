/**
 * M-Pesa Express callback parsing and result-code interpretation.
 *
 * Callbacks are NOT signed by Safaricom. They are treated as untrusted hints:
 * the structure is validated here, the IDs are matched to a stored payment,
 * and (by default) the outcome is confirmed with an STK status query before
 * any booking changes. See src/server/payments/mpesa.ts.
 */

export type StkCallback = {
  merchantRequestId: string;
  checkoutRequestId: string;
  resultCode: string;
  resultDesc: string;
  /** Present on success only. */
  amountKes: number | null;
  receipt: string | null;
  transactionDate: string | null;
  phone: string | null;
};

const ID_RE = /^[A-Za-z0-9_-]{4,100}$/;
const RECEIPT_RE = /^[A-Z0-9]{8,20}$/;

export function parseStkCallback(raw: string): { ok: true; callback: StkCallback } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  const cb = (json as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback;
  if (!cb || typeof cb !== "object") return { ok: false, reason: "missing_stkCallback" };

  const { MerchantRequestID, CheckoutRequestID, ResultCode, ResultDesc } = cb;
  if (typeof MerchantRequestID !== "string" || !ID_RE.test(MerchantRequestID)) return { ok: false, reason: "bad_MerchantRequestID" };
  if (typeof CheckoutRequestID !== "string" || !ID_RE.test(CheckoutRequestID)) return { ok: false, reason: "bad_CheckoutRequestID" };
  if ((typeof ResultCode !== "number" && typeof ResultCode !== "string") || !/^[A-Za-z0-9_]{1,20}$/.test(String(ResultCode))) {
    return { ok: false, reason: "bad_ResultCode" };
  }

  const items = (cb.CallbackMetadata as { Item?: unknown } | undefined)?.Item;
  const meta = new Map<string, unknown>();
  if (Array.isArray(items)) {
    for (const it of items) {
      if (it && typeof it === "object" && typeof (it as { Name?: unknown }).Name === "string") {
        meta.set((it as { Name: string }).Name, (it as { Value?: unknown }).Value);
      }
    }
  }
  const resultCode = String(ResultCode);
  const amount = meta.has("Amount") ? Number(meta.get("Amount")) : null;
  const receipt = meta.has("MpesaReceiptNumber") ? String(meta.get("MpesaReceiptNumber")) : null;
  const phone = meta.has("PhoneNumber") ? String(meta.get("PhoneNumber")) : null;

  if (resultCode === "0") {
    // A success without amount + receipt can't be validated or reconciled.
    if (amount === null || !Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "success_without_amount" };
    if (!receipt || !RECEIPT_RE.test(receipt)) return { ok: false, reason: "success_without_receipt" };
  }

  return {
    ok: true,
    callback: {
      merchantRequestId: MerchantRequestID,
      checkoutRequestId: CheckoutRequestID,
      resultCode,
      resultDesc: typeof ResultDesc === "string" ? ResultDesc.slice(0, 300) : "",
      amountKes: amount,
      receipt,
      transactionDate: meta.has("TransactionDate") ? String(meta.get("TransactionDate")) : null,
      phone: phone && /^\d{9,15}$/.test(phone) ? phone : null,
    },
  };
}

/** Phone numbers are personal data: keep only enough to recognise them. */
export function maskMsisdn(phone: string | null | undefined) {
  if (!phone) return null;
  return phone.length > 6 ? `${phone.slice(0, 5)}****${phone.slice(-3)}` : "****";
}

/** What we persist in payment_events: identifiers and outcome, no balance, masked phone. */
export function redactCallback(cb: StkCallback) {
  return {
    MerchantRequestID: cb.merchantRequestId,
    CheckoutRequestID: cb.checkoutRequestId,
    ResultCode: cb.resultCode,
    ResultDesc: cb.resultDesc,
    Amount: cb.amountKes,
    MpesaReceiptNumber: cb.receipt,
    TransactionDate: cb.transactionDate,
    PhoneNumber: maskMsisdn(cb.phone),
  };
}

export type MpesaOutcome = "succeeded" | "failed" | "cancelled" | "expired";

/**
 * Result codes from the M-Pesa Express documentation:
 * 0 success · 1 insufficient balance · 2/3/4/8 limit rules · 17 duplicate within
 * 2 min · 1019 expired · 1025 push error · 1032 cancelled by user · 1037 phone
 * unreachable · 2001 wrong PIN · 2028/SFC_IC0003 merchant misconfiguration ·
 * 8006 security credential locked.
 */
export function interpretResultCode(code: string): { status: MpesaOutcome; customerMessage: string; merchantProblem: boolean } {
  switch (code) {
    case "0":
      return { status: "succeeded", customerMessage: "Payment received.", merchantProblem: false };
    case "1032":
      return { status: "cancelled", customerMessage: "The M-Pesa prompt was cancelled on your phone.", merchantProblem: false };
    case "1037":
      return { status: "expired", customerMessage: "We couldn't reach your phone. Make sure it's on, unlocked and has network, then try again.", merchantProblem: false };
    case "1019":
      return { status: "expired", customerMessage: "The M-Pesa prompt expired before it was completed.", merchantProblem: false };
    case "1":
      return { status: "failed", customerMessage: "Your M-Pesa balance was not enough for this payment.", merchantProblem: false };
    case "2":
    case "3":
    case "4":
    case "8":
      return { status: "failed", customerMessage: "M-Pesa declined the payment because of a transaction limit.", merchantProblem: false };
    case "17":
      return { status: "failed", customerMessage: "M-Pesa blocked a repeat payment. Wait 2 minutes before trying again.", merchantProblem: false };
    case "2001":
      return { status: "failed", customerMessage: "The M-Pesa PIN entered was incorrect.", merchantProblem: false };
    case "8006":
      return { status: "failed", customerMessage: "Your M-Pesa PIN is locked. Call Safaricom customer care (100 or 200).", merchantProblem: false };
    case "2028":
    case "SFC_IC0003":
      return { status: "failed", customerMessage: "M-Pesa payments are temporarily unavailable. You have not been charged.", merchantProblem: true };
    default:
      return { status: "failed", customerMessage: "M-Pesa couldn't complete the payment. You have not been charged.", merchantProblem: false };
  }
}

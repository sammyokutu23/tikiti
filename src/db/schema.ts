/**
 * TikoSoko database schema (PostgreSQL, Drizzle ORM).
 *
 * Conventions
 *  - Money is stored as integer minor units (KES cents) in `*_minor` columns.
 *  - Every instant is `timestamptz` (stored UTC). Events carry an IANA time zone
 *    (default Africa/Nairobi) used only for display.
 *  - Inventory counters live on ticket_types and are changed only with atomic,
 *    guarded UPDATEs inside transactions (see src/server/inventory).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  type AnyPgColumn,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  unique,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

// ─── Enums ──────────────────────────────────────────────────────────────────

export const userRole = pgEnum("user_role", ["customer", "organizer", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "suspended"]);
export const verificationStatus = pgEnum("organizer_verification_status", [
  "pending",
  "verified",
  "rejected",
  "suspended",
]);
export const eventCategory = pgEnum("event_category", [
  "music",
  "festival",
  "nightlife",
  "conference",
  "sports",
  "workshop",
  "comedy",
  "arts",
]);
export const eventStatus = pgEnum("event_status", ["draft", "published", "cancelled"]);
/** Only general_admission is implemented. See docs/RESERVED_SEATING.md. */
export const seatingMode = pgEnum("seating_mode", ["general_admission", "reserved_seating"]);
export const reportStatus = pgEnum("report_status", ["open", "resolved", "dismissed"]);

export const bookingStatus = pgEnum("booking_status", [
  "pending", // inventory held, awaiting payment
  "confirmed",
  "expired", // hold lapsed before a verified payment
  "cancelled", // customer abandoned / event cancelled before payment
  "failed", // payment succeeded too late and inventory was gone → refunded
  "refunded",
  "on_plan", // Lipa Mdogo Mdogo: deposit paid, inventory held until the plan is paid off (no tickets yet)
]);
export const bookingPaymentStatus = pgEnum("booking_payment_status", [
  "unpaid",
  "pending",
  "paid",
  "failed",
  "refund_pending",
  "refunded",
  "not_required",
  "partially_paid", // payment plan in progress
]);
/** Where the booking's units are counted on ticket_types. */
export const inventoryState = pgEnum("inventory_state", ["held", "committed", "released"]);

export const paymentStatus = pgEnum("payment_status", [
  "created", // row written; provider request in flight or its outcome unknown (e.g. timeout)
  "pending", // provider accepted the request; awaiting the customer / result
  "succeeded",
  "failed",
  "cancelled", // customer declined (e.g. cancelled the M-Pesa prompt)
  "refunded",
  "expired", // customer never answered the prompt in time
  "reconciliation_required", // outcome could not be verified automatically → admin review
]);
export const paymentMethod = pgEnum("payment_method", ["mpesa", "card", "free"]);

export const ticketStatus = pgEnum("ticket_status", ["valid", "checked_in", "revoked", "refunded"]);
export const scanResult = pgEnum("scan_result", [
  "accepted",
  "already_checked_in",
  "revoked",
  "refunded",
  "invalid",
  "wrong_event",
  "not_confirmed",
]);
export const refundStatus = pgEnum("refund_status", ["pending", "succeeded", "failed", "manual_required"]);
export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "ticket_sale",
  "platform_commission",
  "refund",
  "commission_reversal",
  "adjustment",
]);
/**
 * queued → sending → accepted (Resend took it) → delivered | delivery_delayed | bounced | complained
 * sending → retry_pending (transient/uncertain error) → sending …
 * sending → failed (permanent error or retries exhausted) · suppressed (address on the suppression list)
 * skipped = no longer relevant at send time (e.g. "payment failed" after the booking got paid).
 * "sent" is used by SMTP (no delivery feedback) and "captured" by the dev mailbox.
 */
export const emailStatus = pgEnum("email_status", [
  "queued",
  "sending",
  "sent",
  "captured",
  "failed",
  "accepted",
  "delivered",
  "delivery_delayed",
  "bounced",
  "complained",
  "suppressed",
  "retry_pending",
  "skipped",
]);
export const jobStatus = pgEnum("job_status", ["pending", "running", "succeeded", "failed"]);
/**
 * Lipa Mdogo Mdogo plan lifecycle (layaway, no interest or penalties):
 *   awaiting_deposit ──deposit verified──▶ active ──balance verified──▶ fully_paid (tickets issued)
 *   awaiting_deposit ──hold lapsed / checkout cancelled──▶ expired
 *   active ──missed deadline / customer or admin cancel / event cancelled──▶ refund_pending ──refunds settled──▶ refunded
 *   (nothing paid yet → cancelled / expired directly)
 *   any ended plan ──payment verified afterwards──▶ reconciliation_required (admin reinstates or refunds)
 */
export const planStatus = pgEnum("payment_plan_status", [
  "awaiting_deposit",
  "active",
  "fully_paid",
  "cancelled",
  "expired",
  "refund_pending",
  "refunded",
  "reconciliation_required",
]);
/** Per-installment state; payment attempts keep their own status in payment_transactions. */
export const installmentStatus = pgEnum("installment_status", [
  "scheduled",
  "due",
  "payment_pending",
  "paid",
  "failed",
  "overdue",
  "cancelled",
]);
export const bannerGenerationStatus = pgEnum("banner_generation_status", ["pending", "succeeded", "failed"]);
/** A TikoSoko-issued ticket (verified, reissued on sale) or one bought on another platform. */
export const resaleListingKind = pgEnum("resale_listing_kind", ["platform", "external"]);
/**
 * Resale listing lifecycle:
 *   platform: active ──buyer's payment verified──▶ sold
 *   external: pending_review ──admin approves──▶ active ──▶ sold
 *             pending_review ──admin rejects──▶ rejected
 *   active ──seller withdraws──▶ cancelled
 *   active ──event ended / ticket used, refunded or revoked──▶ closed
 */
export const resaleListingStatus = pgEnum("resale_listing_status", ["pending_review", "active", "sold", "cancelled", "rejected", "closed"]);
/**
 * Seller payout (escrow): held until release_at (after the event), then an admin
 * sends it by M-Pesa and records the receipt. A buyer dispute pauses it; a
 * refund to the buyer cancels it.
 */
export const resalePayoutStatus = pgEnum("resale_payout_status", ["held", "disputed", "paid", "cancelled"]);

// ─── Identity ───────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    phone: text("phone"),
    /** Clerk user id (user_…). Identity lives in Clerk; roles & data live here. */
    clerkUserId: text("clerk_user_id").unique(),
    /** Legacy local-password hash (pre-Clerk). Unused for sign-in; kept for non-destructive migration. */
    passwordHash: text("password_hash"),
    role: userRole("role").notNull().default("customer"),
    status: userStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** sha256 of the opaque cookie token; the raw token is never stored. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

// ─── Organizers ─────────────────────────────────────────────────────────────

export const organizerProfiles = pgTable("organizer_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "restrict" }),
  displayName: text("display_name").notNull(),
  slug: text("slug").notNull().unique(),
  bio: text("bio"),
  contactEmail: text("contact_email").notNull(),
  contactPhone: text("contact_phone").notNull(),
  city: text("city"),
  website: text("website"),
  verificationStatus: verificationStatus("verification_status").notNull().default("pending"),
  verificationNote: text("verification_note"),
  verifiedAt: ts("verified_at"),
  verifiedBy: uuid("verified_by").references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ─── Events ─────────────────────────────────────────────────────────────────

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizerId: uuid("organizer_id")
      .notNull()
      .references(() => organizerProfiles.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    description: text("description").notNull().default(""),
    category: eventCategory("category").notNull(),
    coverImageUrl: text("cover_image_url"),
    venueName: text("venue_name").notNull(),
    venueAddress: text("venue_address").notNull().default(""),
    city: text("city").notNull(),
    /**
     * Venue pin (WGS84). Nullable so legacy events stay valid; when absent the
     * UI shows an address-only fallback and never a default marker. Set only
     * from an organizer-confirmed pin (the geocoded point is just a starting guess).
     */
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    /** Geocoder that produced the starting point ("nominatim", "manual"), and its place id. */
    locationProvider: text("location_provider"),
    locationPlaceId: text("location_place_id"),
    locationConfirmedAt: ts("location_confirmed_at"),
    arrivalInstructions: text("arrival_instructions").notNull().default(""),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    timezone: text("timezone").notNull().default("Africa/Nairobi"),
    status: eventStatus("status").notNull().default("draft"),
    seatingMode: seatingMode("seating_mode").notNull().default("general_admission"),
    refundPolicy: text("refund_policy").notNull().default(""),
    /** Organizer opt-in for Lipa Mdogo Mdogo installment plans. */
    installmentsEnabled: boolean("installments_enabled").notNull().default(false),
    isFeatured: boolean("is_featured").notNull().default(false),
    /** Outside event created for a resale listing of a ticket bought elsewhere. Never listed publicly. */
    isExternal: boolean("is_external").notNull().default(false),
    /** Admin moderation: hidden events never appear publicly regardless of status. */
    isHidden: boolean("is_hidden").notNull().default(false),
    hiddenReason: text("hidden_reason"),
    publishedAt: ts("published_at"),
    cancelledAt: ts("cancelled_at"),
    cancellationReason: text("cancellation_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("events_public_idx").on(t.status, t.isHidden, t.startsAt),
    index("events_organizer_idx").on(t.organizerId),
    check("events_time_order", sql`${t.endsAt} > ${t.startsAt}`),
    check(
      "events_coordinates_valid",
      // Explicit NOT NULLs: a CHECK that evaluates to NULL would otherwise pass.
      sql`(${t.latitude} IS NULL AND ${t.longitude} IS NULL) OR (${t.latitude} IS NOT NULL AND ${t.longitude} IS NOT NULL AND ${t.latitude} BETWEEN -90 AND 90 AND ${t.longitude} BETWEEN -180 AND 180)`,
    ),
  ],
);

export const eventReports = pgTable("event_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  reporterUserId: uuid("reporter_user_id").references(() => users.id),
  reporterEmail: text("reporter_email"),
  reason: text("reason").notNull(),
  details: text("details").notNull().default(""),
  status: reportStatus("status").notNull().default("open"),
  resolvedBy: uuid("resolved_by").references(() => users.id),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
});

// ─── Ticket types & inventory ───────────────────────────────────────────────

export const ticketTypes = pgTable(
  "ticket_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull().default("KES"),
    capacity: integer("capacity").notNull(),
    /** Units in confirmed bookings. */
    sold: integer("sold").notNull().default(0),
    /** Units held by pending bookings (temporary reservations). */
    reserved: integer("reserved").notNull().default(0),
    maxPerOrder: integer("max_per_order").notNull().default(10),
    salesStartAt: ts("sales_start_at"),
    salesEndAt: ts("sales_end_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("ticket_types_event_idx").on(t.eventId),
    check("ticket_types_price_nonneg", sql`${t.priceMinor} >= 0`),
    check("ticket_types_counts_nonneg", sql`${t.sold} >= 0 AND ${t.reserved} >= 0 AND ${t.capacity} >= 0`),
    check("ticket_types_no_oversell", sql`${t.sold} + ${t.reserved} <= ${t.capacity}`),
    check("ticket_types_max_per_order", sql`${t.maxPerOrder} BETWEEN 1 AND 50`),
  ],
);

// ─── Bookings ───────────────────────────────────────────────────────────────

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public, human-friendly reference. Not an access credential. */
    reference: text("reference").notNull().unique(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    buyerName: text("buyer_name").notNull(),
    buyerEmail: text("buyer_email").notNull(),
    buyerPhone: text("buyer_phone").notNull(),
    status: bookingStatus("status").notNull().default("pending"),
    paymentStatus: bookingPaymentStatus("payment_status").notNull().default("unpaid"),
    inventoryState: inventoryState("inventory_state").notNull().default("held"),
    currency: text("currency").notNull().default("KES"),
    /** Snapshot of face value at booking time. */
    subtotalMinor: integer("subtotal_minor").notNull(),
    /** Buyer-paid fees (0 in the current pricing model). */
    feesMinor: integer("fees_minor").notNull().default(0),
    discountMinor: integer("discount_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    /** Commission rate snapshot (basis points) and resulting amount. */
    commissionBps: integer("commission_bps").notNull(),
    commissionMinor: integer("commission_minor").notNull(),
    expiresAt: ts("expires_at").notNull(),
    confirmedAt: ts("confirmed_at"),
    cancelledAt: ts("cancelled_at"),
    /** Client-supplied key; repeated checkout submissions return the same booking. */
    idempotencyKey: text("idempotency_key").unique(),
    /** Set when this booking buys a resale listing instead of new inventory (see ../server/resale). */
    resaleListingId: uuid("resale_listing_id").references((): AnyPgColumn => resaleListings.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bookings_event_idx").on(t.eventId, t.status),
    index("bookings_resale_listing_idx").on(t.resaleListingId),
    // A listing can be sold once.
    uniqueIndex("bookings_resale_confirmed_uq").on(t.resaleListingId).where(sql`${t.status} = 'confirmed'`),
    index("bookings_user_idx").on(t.userId),
    index("bookings_email_idx").on(sql`lower(${t.buyerEmail})`),
    index("bookings_pending_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'pending'`),
    check(
      "bookings_amounts",
      sql`${t.subtotalMinor} >= 0 AND ${t.totalMinor} >= 0 AND ${t.commissionMinor} >= 0 AND ${t.totalMinor} = ${t.subtotalMinor} + ${t.feesMinor} - ${t.discountMinor}`,
    ),
  ],
);

export const bookingItems = pgTable(
  "booking_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    ticketTypeId: uuid("ticket_type_id")
      .notNull()
      .references(() => ticketTypes.id, { onDelete: "restrict" }),
    ticketTypeName: text("ticket_type_name").notNull(),
    unitPriceMinor: integer("unit_price_minor").notNull(),
    quantity: integer("quantity").notNull(),
    lineTotalMinor: integer("line_total_minor").notNull(),
  },
  (t) => [
    unique("booking_items_booking_type_uq").on(t.bookingId, t.ticketTypeId),
    check("booking_items_qty", sql`${t.quantity} > 0`),
  ],
);

// ─── Payments ───────────────────────────────────────────────────────────────

export const paymentTransactions = pgTable(
  "payment_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    method: paymentMethod("method").notNull(),
    status: paymentStatus("status").notNull().default("created"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("KES"),
    /** The provider's id for this payment (e.g. M-Pesa CheckoutRequestID). */
    providerReference: text("provider_reference").unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    payerPhone: text("payer_phone"),
    failureReason: text("failure_reason"),
    /** M-Pesa MerchantRequestID (returned with the CheckoutRequestID). */
    merchantRequestId: text("merchant_request_id"),
    /** Set when this attempt pays one installment of a payment plan (amount = that installment). */
    installmentId: uuid("installment_id").references((): AnyPgColumn => planInstallments.id),
    /** Provider receipt, e.g. the M-Pesa receipt number. One receipt pays one attempt. */
    providerReceipt: text("provider_receipt").unique(),
    providerResultCode: text("provider_result_code"),
    providerResultDesc: text("provider_result_desc"),
    /** Reconciliation (status-query) bookkeeping for missed or unverified callbacks. */
    statusCheckAttempts: integer("status_check_attempts").notNull().default(0),
    nextStatusCheckAt: ts("next_status_check_at"),
    lastStatusCheckAt: ts("last_status_check_at"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payment_transactions_booking_idx").on(t.bookingId),
    index("payment_transactions_installment_idx").on(t.installmentId),
    index("payment_transactions_status_check_idx")
      .on(t.nextStatusCheckAt)
      .where(sql`${t.status} IN ('created', 'pending')`),
    // At most one in-flight M-Pesa prompt per booking: prevents duplicate charges.
    uniqueIndex("payment_transactions_one_active_daraja_uq")
      .on(t.bookingId)
      .where(sql`${t.provider} = 'daraja' AND ${t.status} IN ('created', 'pending')`),
  ],
);

/**
 * Every provider message received or fetched, verified or not: webhooks,
 * M-Pesa callbacks and status-query results. Unique per provider event id.
 */
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    /** "webhook" (signed), "callback" (unsigned M-Pesa result) or "status_query". */
    kind: text("kind").notNull().default("webhook"),
    providerEventId: text("provider_event_id").notNull(),
    providerReference: text("provider_reference"),
    signatureValid: boolean("signature_valid").notNull(),
    payload: jsonb("payload").notNull(),
    outcome: text("outcome"),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [unique("payment_events_provider_event_uq").on(t.provider, t.providerEventId)],
);

// ─── Tickets & check-in ─────────────────────────────────────────────────────

export const tickets = pgTable(
  "tickets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Random, unguessable ticket code (also printed on the ticket). */
    code: text("code").notNull().unique(),
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "restrict" }),
    bookingItemId: uuid("booking_item_id")
      .notNull()
      .references(() => bookingItems.id, { onDelete: "restrict" }),
    /** 1..quantity within the booking item — makes issuance idempotent. */
    sequence: integer("sequence").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    ticketTypeId: uuid("ticket_type_id")
      .notNull()
      .references(() => ticketTypes.id, { onDelete: "restrict" }),
    attendeeName: text("attendee_name"),
    status: ticketStatus("status").notNull().default("valid"),
    checkedInAt: ts("checked_in_at"),
    checkedInBy: uuid("checked_in_by").references(() => users.id),
    revokedAt: ts("revoked_at"),
    revokeReason: text("revoke_reason"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tickets_item_sequence_uq").on(t.bookingItemId, t.sequence),
    index("tickets_event_idx").on(t.eventId, t.status),
    index("tickets_booking_idx").on(t.bookingId),
  ],
);

/** Log of every scan attempt (accepted or not). */
export const checkIns = pgTable(
  "check_ins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ticketId: uuid("ticket_id").references(() => tickets.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    scannedBy: uuid("scanned_by")
      .notNull()
      .references(() => users.id),
    result: scanResult("result").notNull(),
    rawCode: text("raw_code"),
    createdAt: createdAt(),
  },
  (t) => [index("check_ins_event_idx").on(t.eventId, t.createdAt)],
);

// ─── Refunds & ledger ───────────────────────────────────────────────────────

export const refunds = pgTable("refunds", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "restrict" }),
  paymentTransactionId: uuid("payment_transaction_id").references(() => paymentTransactions.id),
  amountMinor: integer("amount_minor").notNull(),
  commissionReversedMinor: integer("commission_reversed_minor").notNull().default(0),
  reason: text("reason").notNull(),
  status: refundStatus("status").notNull().default("pending"),
  providerReference: text("provider_reference"),
  initiatedBy: uuid("initiated_by").references(() => users.id),
  processedAt: ts("processed_at"),
  createdAt: createdAt(),
});

/**
 * Organizer-perspective ledger. Positive amounts increase what the platform
 * owes the organizer, negative amounts decrease it. Balances are estimates —
 * no settlement/payout is performed by the prototype.
 */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizerId: uuid("organizer_id")
      .notNull()
      .references(() => organizerProfiles.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    bookingId: uuid("booking_id").references(() => bookings.id),
    refundId: uuid("refund_id").references(() => refunds.id),
    type: ledgerEntryType("type").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("KES"),
    description: text("description").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("ledger_entries_idempotency_uq").on(t.bookingId, t.refundId, t.type).nullsNotDistinct(),
    index("ledger_entries_organizer_idx").on(t.organizerId),
    index("ledger_entries_event_idx").on(t.eventId),
  ],
);

export const platformSettings = pgTable("platform_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id),
  updatedAt: updatedAt(),
});

// ─── Payment plans (Lipa Mdogo Mdogo) ───────────────────────────────────────

export const paymentPlans = pgTable(
  "payment_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bookingId: uuid("booking_id")
      .notNull()
      .unique()
      .references(() => bookings.id, { onDelete: "restrict" }),
    status: planStatus("status").notNull().default("awaiting_deposit"),
    currency: text("currency").notNull().default("KES"),
    /** Agreed amounts, fixed at creation; later price or policy changes never alter them. */
    totalMinor: integer("total_minor").notNull(),
    depositMinor: integer("deposit_minor").notNull(),
    /** Sum of verified installment payments applied to this plan. */
    paidMinor: integer("paid_minor").notNull().default(0),
    /** Installments after the deposit. */
    installmentCount: integer("installment_count").notNull(),
    /** Everything must be paid by this instant (event start minus the policy's final-deadline window). */
    finalDueAt: ts("final_due_at").notNull(),
    /** Retained on cancellation/expiry (0 under the default policy: full refund). */
    cancellationFeeMinor: integer("cancellation_fee_minor").notNull().default(0),
    /** Snapshot of the installment policy the customer accepted. */
    policy: jsonb("policy").notNull(),
    termsVersion: text("terms_version").notNull(),
    termsAcceptedAt: ts("terms_accepted_at").notNull(),
    activatedAt: ts("activated_at"),
    completedAt: ts("completed_at"),
    endedAt: ts("ended_at"),
    /** missed_installment | deadline_passed | customer_cancelled | admin_cancelled | event_cancelled | hold_expired */
    endReason: text("end_reason"),
    reconciliationNote: text("reconciliation_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("payment_plans_status_idx").on(t.status, t.finalDueAt),
    check("payment_plans_amounts", sql`${t.depositMinor} > 0 AND ${t.depositMinor} <= ${t.totalMinor} AND ${t.paidMinor} >= 0 AND ${t.paidMinor} <= ${t.totalMinor} AND ${t.cancellationFeeMinor} >= 0`),
    check("payment_plans_installments", sql`${t.installmentCount} BETWEEN 1 AND 12`),
  ],
);

export const planInstallments = pgTable(
  "plan_installments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => paymentPlans.id, { onDelete: "cascade" }),
    /** 0 = deposit, 1..n = installments, paid strictly in order. */
    sequence: integer("sequence").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    dueAt: ts("due_at").notNull(),
    status: installmentStatus("status").notNull().default("scheduled"),
    /** The verified payment that settled this installment (exactly one). */
    paymentTransactionId: uuid("payment_transaction_id").references((): AnyPgColumn => paymentTransactions.id),
    paidAt: ts("paid_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("plan_installments_plan_sequence_uq").on(t.planId, t.sequence),
    uniqueIndex("plan_installments_payment_uq").on(t.paymentTransactionId),
    index("plan_installments_due_idx").on(t.status, t.dueAt),
    check("plan_installments_amount", sql`${t.amountMinor} > 0`),
  ],
);

// ─── AI banner generations ──────────────────────────────────────────────────

/** One row per generation request (n images). Pending rows count toward usage limits. */
export const bannerGenerations = pgTable(
  "banner_generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizerId: uuid("organizer_id")
      .notNull()
      .references(() => organizerProfiles.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    status: bannerGenerationStatus("status").notNull().default("pending"),
    model: text("model").notNull(),
    style: text("style").notNull(),
    format: text("format").notNull(),
    size: text("size").notNull(),
    quality: text("quality").notNull(),
    imageCount: integer("image_count").notNull(),
    /** The organizer's own creative brief. The full provider prompt is internal and not stored. */
    brief: text("brief").notNull().default(""),
    /** Stored background artwork (no event text), one URL per generated image. */
    imageUrls: jsonb("image_urls").notNull().default([]),
    errorCategory: text("error_category"),
    errorMessage: text("error_message"),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("banner_generations_org_idx").on(t.organizerId, t.createdAt),
    index("banner_generations_event_idx").on(t.eventId, t.createdAt),
    // One request in flight per organizer: double clicks can't start parallel (billed) generations.
    uniqueIndex("banner_generations_one_pending_uq").on(t.organizerId).where(sql`${t.status} = 'pending'`),
    check("banner_generations_count", sql`${t.imageCount} BETWEEN 1 AND 4`),
  ],
);

// ─── Email & jobs ───────────────────────────────────────────────────────────

export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    bookingId: uuid("booking_id").references(() => bookings.id),
    userId: uuid("user_id").references(() => users.id),
    eventId: uuid("event_id").references(() => events.id),
    toEmail: text("to_email").notNull(),
    subject: text("subject").notNull(),
    status: emailStatus("status").notNull().default("queued"),
    transport: text("transport"),
    /** Provider's id for the accepted message (Resend email id). Webhooks are matched on it. */
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** config | invalid_recipient | rejected | rate_limited | quota | provider_unavailable | uncertain | idempotency_conflict | render | bounce | complaint … */
    lastErrorCategory: text("last_error_category"),
    attachmentCount: integer("attachment_count").notNull().default(0),
    /** Small, non-sensitive template inputs (e.g. which event fields changed). Never bodies or attachments. */
    metadata: jsonb("metadata").notNull().default({}),
    /** First provider attempt — the Idempotency-Key is only honoured by Resend for 24h after it. */
    firstAttemptAt: ts("first_attempt_at"),
    sentAt: ts("sent_at"),
    deliveredAt: ts("delivered_at"),
    /** Timestamp of the newest provider event applied (events can arrive out of order). */
    lastEventAt: ts("last_event_at"),
    /** Prevents duplicate automatic emails, e.g. "booking_confirmation:<bookingId>". */
    dedupeKey: text("dedupe_key").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("email_deliveries_booking_idx").on(t.bookingId),
    index("email_deliveries_status_idx").on(t.status, t.updatedAt),
    uniqueIndex("email_deliveries_provider_message_uq").on(t.providerMessageId),
  ],
);

/** Delivery webhooks (Resend). The svix/webhook id makes replays idempotent. */
export const emailProviderEvents = pgTable(
  "email_provider_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    type: text("type").notNull(),
    providerMessageId: text("provider_message_id"),
    deliveryId: uuid("delivery_id").references(() => emailDeliveries.id),
    occurredAt: ts("occurred_at"),
    /** Minimal, redacted details (bounce type/message, failure reason). No recipient lists or bodies. */
    detail: jsonb("detail").notNull().default({}),
    /** null until applied to a delivery (it may arrive before we stored the provider id). */
    appliedAt: ts("applied_at"),
    outcome: text("outcome"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("email_provider_events_provider_event_uq").on(t.provider, t.providerEventId),
    index("email_provider_events_message_idx").on(t.providerMessageId),
  ],
);

/** Addresses we must not email automatically (hard bounce, spam complaint). Admins can lift an entry. */
export const emailSuppressions = pgTable(
  "email_suppressions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    /** hard_bounce | complaint */
    reason: text("reason").notNull(),
    detail: text("detail"),
    deliveryId: uuid("delivery_id").references(() => emailDeliveries.id),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("email_suppressions_email_lower_uq").on(sql`lower(${t.email})`)],
);

/** Transactional outbox: rows are inserted in the same DB transaction as the state change. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at").notNull().defaultNow(),
    lockedAt: ts("locked_at"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key").unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_pending_idx").on(t.runAt).where(sql`${t.status} = 'pending'`)],
);

// ─── Resale marketplace ─────────────────────────────────────────────────────

export const resaleListings = pgTable(
  "resale_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public reference, e.g. RS-7KQ2-9XHM. */
    reference: text("reference").notNull().unique(),
    kind: resaleListingKind("kind").notNull(),
    status: resaleListingStatus("status").notNull(),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id),
    /** Platform: the ticket's event. External: set when an admin approves (linked or outside event). */
    eventId: uuid("event_id").references(() => events.id),
    /** Platform listings only: the seller's ticket, revoked and reissued to the buyer on sale. */
    ticketId: uuid("ticket_id").references(() => tickets.id),
    ticketTypeName: text("ticket_type_name").notNull(),
    /** Asking price; the seller receives all of it. The buyer pays it plus the resale fee. */
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull().default("KES"),
    /** M-Pesa number the seller is paid on. */
    payoutPhone: text("payout_phone").notNull(),
    /** External listings: what the seller told us about the ticket. */
    externalEventName: text("external_event_name"),
    externalVenue: text("external_venue"),
    externalCity: text("external_city"),
    externalStartsAt: ts("external_starts_at"),
    externalPlatform: text("external_platform"),
    externalOrderRef: text("external_order_ref"),
    /** External listings: M-Pesa confirmation code from the seller's original purchase (optional). */
    externalMpesaCode: text("external_mpesa_code"),
    sellerNote: text("seller_note").notNull().default(""),
    /** Verification bot (external listings): pending | passed | flagged | error. Advisory only; an admin always approves. */
    checkStatus: text("check_status"),
    checkResult: jsonb("check_result"),
    checkedAt: ts("checked_at"),
    reviewNote: text("review_note"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: ts("reviewed_at"),
    soldBookingId: uuid("sold_booking_id").references((): AnyPgColumn => bookings.id),
    soldAt: ts("sold_at"),
    closedAt: ts("closed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("resale_listings_status_idx").on(t.status, t.eventId),
    index("resale_listings_seller_idx").on(t.sellerUserId),
    // One open listing per ticket.
    uniqueIndex("resale_listings_open_ticket_uq").on(t.ticketId).where(sql`${t.status} IN ('pending_review', 'active')`),
    check("resale_listings_price", sql`${t.priceMinor} > 0 AND ${t.priceMinor} % 100 = 0`),
    check(
      "resale_listings_kind_fields",
      sql`(${t.kind} = 'platform' AND ${t.ticketId} IS NOT NULL AND ${t.eventId} IS NOT NULL) OR (${t.kind} = 'external' AND ${t.ticketId} IS NULL AND ${t.externalEventName} IS NOT NULL AND ${t.externalStartsAt} IS NOT NULL)`,
    ),
    check("resale_listings_live_has_event", sql`${t.status} NOT IN ('active', 'sold') OR ${t.eventId} IS NOT NULL`),
  ],
);

/**
 * Files a seller uploads for an external listing: the ticket itself (handed to the
 * buyer after payment) and proof of purchase (admins only). Stored in the database,
 * never in the public image bucket.
 */
export const resaleDocuments = pgTable(
  "resale_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .references(() => resaleListings.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    data: bytea("data").notNull(),
    /** Set when an admin replaces the file; kept for the record, never shown to buyers. */
    withdrawnAt: ts("withdrawn_at"),
    withdrawnBy: uuid("withdrawn_by").references(() => users.id),
    /** The admin who uploaded this file as a replacement (null for the seller's upload). */
    uploadedBy: uuid("uploaded_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("resale_documents_listing_idx").on(t.listingId),
    check("resale_documents_purpose", sql`${t.purpose} IN ('ticket', 'proof')`),
  ],
);

export const resalePayouts = pgTable(
  "resale_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    listingId: uuid("listing_id")
      .notNull()
      .unique()
      .references(() => resaleListings.id),
    bookingId: uuid("booking_id")
      .notNull()
      .unique()
      .references(() => bookings.id),
    sellerUserId: uuid("seller_user_id")
      .notNull()
      .references(() => users.id),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull().default("KES"),
    payoutPhone: text("payout_phone").notNull(),
    status: resalePayoutStatus("status").notNull().default("held"),
    /** Earliest moment an admin may pay it out (after the event, plus a window for buyer reports). */
    releaseAt: ts("release_at").notNull(),
    disputeReason: text("dispute_reason"),
    disputedAt: ts("disputed_at"),
    paidAt: ts("paid_at"),
    paidBy: uuid("paid_by").references(() => users.id),
    /** M-Pesa receipt of the payout, recorded by the admin who sent it. */
    payoutReference: text("payout_reference"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("resale_payouts_status_idx").on(t.status, t.releaseAt),
    index("resale_payouts_seller_idx").on(t.sellerUserId),
    check("resale_payouts_amount", sql`${t.amountMinor} > 0`),
  ],
);

// ─── Audit ──────────────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entityType, t.entityId),
    index("audit_logs_created_idx").on(t.createdAt),
  ],
);

export type User = typeof users.$inferSelect;
export type OrganizerProfile = typeof organizerProfiles.$inferSelect;
export type Event = typeof events.$inferSelect;
export type TicketType = typeof ticketTypes.$inferSelect;
export type Booking = typeof bookings.$inferSelect;
export type BookingItem = typeof bookingItems.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type PaymentTransaction = typeof paymentTransactions.$inferSelect;
export type EmailDelivery = typeof emailDeliveries.$inferSelect;
export type PaymentPlan = typeof paymentPlans.$inferSelect;
export type PlanInstallment = typeof planInstallments.$inferSelect;
export type BannerGeneration = typeof bannerGenerations.$inferSelect;
export type ResaleListing = typeof resaleListings.$inferSelect;
export type ResalePayout = typeof resalePayouts.$inferSelect;

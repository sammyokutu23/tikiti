CREATE TYPE "public"."booking_payment_status" AS ENUM('unpaid', 'pending', 'paid', 'failed', 'refund_pending', 'refunded', 'not_required');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('pending', 'confirmed', 'expired', 'cancelled', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('queued', 'sending', 'sent', 'captured', 'failed');--> statement-breakpoint
CREATE TYPE "public"."event_category" AS ENUM('music', 'festival', 'nightlife', 'conference', 'sports', 'workshop', 'comedy', 'arts');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."inventory_state" AS ENUM('held', 'committed', 'released');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('ticket_sale', 'platform_commission', 'refund', 'commission_reversal', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('mpesa', 'card', 'free');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'pending', 'succeeded', 'failed', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."scan_result" AS ENUM('accepted', 'already_checked_in', 'revoked', 'refunded', 'invalid', 'wrong_event', 'not_confirmed');--> statement-breakpoint
CREATE TYPE "public"."seating_mode" AS ENUM('general_admission', 'reserved_seating');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('valid', 'checked_in', 'revoked', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'organizer', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."organizer_verification_status" AS ENUM('pending', 'verified', 'rejected', 'suspended');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"ticket_type_name" text NOT NULL,
	"unit_price_minor" integer NOT NULL,
	"quantity" integer NOT NULL,
	"line_total_minor" integer NOT NULL,
	CONSTRAINT "booking_items_booking_type_uq" UNIQUE("booking_id","ticket_type_id"),
	CONSTRAINT "booking_items_qty" CHECK ("booking_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"buyer_name" text NOT NULL,
	"buyer_email" text NOT NULL,
	"buyer_phone" text NOT NULL,
	"status" "booking_status" DEFAULT 'pending' NOT NULL,
	"payment_status" "booking_payment_status" DEFAULT 'unpaid' NOT NULL,
	"inventory_state" "inventory_state" DEFAULT 'held' NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"subtotal_minor" integer NOT NULL,
	"fees_minor" integer DEFAULT 0 NOT NULL,
	"discount_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer NOT NULL,
	"commission_bps" integer NOT NULL,
	"commission_minor" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_reference_unique" UNIQUE("reference"),
	CONSTRAINT "bookings_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "bookings_amounts" CHECK ("bookings"."subtotal_minor" >= 0 AND "bookings"."total_minor" >= 0 AND "bookings"."commission_minor" >= 0 AND "bookings"."total_minor" = "bookings"."subtotal_minor" + "bookings"."fees_minor" - "bookings"."discount_minor")
);
--> statement-breakpoint
CREATE TABLE "check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid,
	"event_id" uuid NOT NULL,
	"scanned_by" uuid NOT NULL,
	"result" "scan_result" NOT NULL,
	"raw_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"booking_id" uuid,
	"user_id" uuid,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"status" "email_status" DEFAULT 'queued' NOT NULL,
	"transport" text,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_deliveries_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "event_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"reporter_email" text,
	"reason" text NOT NULL,
	"details" text DEFAULT '' NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"category" "event_category" NOT NULL,
	"cover_image_url" text,
	"venue_name" text NOT NULL,
	"venue_address" text DEFAULT '' NOT NULL,
	"city" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text DEFAULT 'Africa/Nairobi' NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"seating_mode" "seating_mode" DEFAULT 'general_admission' NOT NULL,
	"refund_policy" text DEFAULT '' NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"is_hidden" boolean DEFAULT false NOT NULL,
	"hidden_reason" text,
	"published_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "events_time_order" CHECK ("events"."ends_at" > "events"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"booking_id" uuid,
	"refund_id" uuid,
	"type" "ledger_entry_type" NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_uq" UNIQUE NULLS NOT DISTINCT("booking_id","refund_id","type")
);
--> statement-breakpoint
CREATE TABLE "organizer_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"bio" text,
	"contact_email" text NOT NULL,
	"contact_phone" text NOT NULL,
	"city" text,
	"website" text,
	"verification_status" "organizer_verification_status" DEFAULT 'pending' NOT NULL,
	"verification_note" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizer_profiles_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "organizer_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "password_reset_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_reference" text,
	"signature_valid" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"outcome" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_provider_event_uq" UNIQUE("provider","provider_event_id")
);
--> statement-breakpoint
CREATE TABLE "payment_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"provider_reference" text,
	"idempotency_key" text NOT NULL,
	"payer_phone" text,
	"failure_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_transactions_provider_reference_unique" UNIQUE("provider_reference"),
	CONSTRAINT "payment_transactions_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"payment_transaction_id" uuid,
	"amount_minor" integer NOT NULL,
	"commission_reversed_minor" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"provider_reference" text,
	"initiated_by" uuid,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"capacity" integer NOT NULL,
	"sold" integer DEFAULT 0 NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"max_per_order" integer DEFAULT 10 NOT NULL,
	"sales_start_at" timestamp with time zone,
	"sales_end_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_types_price_nonneg" CHECK ("ticket_types"."price_minor" >= 0),
	CONSTRAINT "ticket_types_counts_nonneg" CHECK ("ticket_types"."sold" >= 0 AND "ticket_types"."reserved" >= 0 AND "ticket_types"."capacity" >= 0),
	CONSTRAINT "ticket_types_no_oversell" CHECK ("ticket_types"."sold" + "ticket_types"."reserved" <= "ticket_types"."capacity"),
	CONSTRAINT "ticket_types_max_per_order" CHECK ("ticket_types"."max_per_order" BETWEEN 1 AND 50)
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"booking_id" uuid NOT NULL,
	"booking_item_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_type_id" uuid NOT NULL,
	"attendee_name" text,
	"status" "ticket_status" DEFAULT 'valid' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" uuid,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_code_unique" UNIQUE("code"),
	CONSTRAINT "tickets_item_sequence_uq" UNIQUE("booking_item_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'customer' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_ins" ADD CONSTRAINT "check_ins_scanned_by_users_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reports" ADD CONSTRAINT "event_reports_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reports" ADD CONSTRAINT "event_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_reports" ADD CONSTRAINT "event_reports_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_organizer_id_organizer_profiles_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizer_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_organizer_id_organizer_profiles_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizer_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_profiles" ADD CONSTRAINT "organizer_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizer_profiles" ADD CONSTRAINT "organizer_profiles_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_transaction_id_payment_transactions_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_booking_item_id_booking_items_id_fk" FOREIGN KEY ("booking_item_id") REFERENCES "public"."booking_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_ticket_type_id_ticket_types_id_fk" FOREIGN KEY ("ticket_type_id") REFERENCES "public"."ticket_types"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "bookings_event_idx" ON "bookings" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "bookings_user_idx" ON "bookings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bookings_email_idx" ON "bookings" USING btree (lower("buyer_email"));--> statement-breakpoint
CREATE INDEX "bookings_pending_expiry_idx" ON "bookings" USING btree ("expires_at") WHERE "bookings"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "check_ins_event_idx" ON "check_ins" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE INDEX "email_deliveries_booking_idx" ON "email_deliveries" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "events_public_idx" ON "events" USING btree ("status","is_hidden","starts_at");--> statement-breakpoint
CREATE INDEX "events_organizer_idx" ON "events" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "jobs_pending_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ledger_entries_organizer_idx" ON "ledger_entries" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_event_idx" ON "ledger_entries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "payment_transactions_booking_idx" ON "payment_transactions" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ticket_types_event_idx" ON "ticket_types" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "tickets_event_idx" ON "tickets" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX "tickets_booking_idx" ON "tickets" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));
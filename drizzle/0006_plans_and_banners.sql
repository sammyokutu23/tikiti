CREATE TYPE "public"."banner_generation_status" AS ENUM('pending', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."installment_status" AS ENUM('scheduled', 'due', 'payment_pending', 'paid', 'failed', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."payment_plan_status" AS ENUM('awaiting_deposit', 'active', 'fully_paid', 'cancelled', 'expired', 'refund_pending', 'refunded', 'reconciliation_required');--> statement-breakpoint
ALTER TYPE "public"."booking_payment_status" ADD VALUE 'partially_paid';--> statement-breakpoint
ALTER TYPE "public"."booking_status" ADD VALUE 'on_plan';--> statement-breakpoint
CREATE TABLE "banner_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid,
	"status" "banner_generation_status" DEFAULT 'pending' NOT NULL,
	"model" text NOT NULL,
	"style" text NOT NULL,
	"format" text NOT NULL,
	"size" text NOT NULL,
	"quality" text NOT NULL,
	"image_count" integer NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"image_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_category" text,
	"error_message" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banner_generations_count" CHECK ("banner_generations"."image_count" BETWEEN 1 AND 4)
);
--> statement-breakpoint
CREATE TABLE "payment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"booking_id" uuid NOT NULL,
	"status" "payment_plan_status" DEFAULT 'awaiting_deposit' NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"total_minor" integer NOT NULL,
	"deposit_minor" integer NOT NULL,
	"paid_minor" integer DEFAULT 0 NOT NULL,
	"installment_count" integer NOT NULL,
	"final_due_at" timestamp with time zone NOT NULL,
	"cancellation_fee_minor" integer DEFAULT 0 NOT NULL,
	"policy" jsonb NOT NULL,
	"terms_version" text NOT NULL,
	"terms_accepted_at" timestamp with time zone NOT NULL,
	"activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"reconciliation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_plans_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "payment_plans_amounts" CHECK ("payment_plans"."deposit_minor" > 0 AND "payment_plans"."deposit_minor" <= "payment_plans"."total_minor" AND "payment_plans"."paid_minor" >= 0 AND "payment_plans"."paid_minor" <= "payment_plans"."total_minor" AND "payment_plans"."cancellation_fee_minor" >= 0),
	CONSTRAINT "payment_plans_installments" CHECK ("payment_plans"."installment_count" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE TABLE "plan_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" "installment_status" DEFAULT 'scheduled' NOT NULL,
	"payment_transaction_id" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_installments_plan_sequence_uq" UNIQUE("plan_id","sequence"),
	CONSTRAINT "plan_installments_amount" CHECK ("plan_installments"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "installments_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "installment_id" uuid;--> statement-breakpoint
ALTER TABLE "banner_generations" ADD CONSTRAINT "banner_generations_organizer_id_organizer_profiles_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."organizer_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banner_generations" ADD CONSTRAINT "banner_generations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banner_generations" ADD CONSTRAINT "banner_generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_installments" ADD CONSTRAINT "plan_installments_plan_id_payment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."payment_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_installments" ADD CONSTRAINT "plan_installments_payment_transaction_id_payment_transactions_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "banner_generations_org_idx" ON "banner_generations" USING btree ("organizer_id","created_at");--> statement-breakpoint
CREATE INDEX "banner_generations_event_idx" ON "banner_generations" USING btree ("event_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "banner_generations_one_pending_uq" ON "banner_generations" USING btree ("organizer_id") WHERE "banner_generations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "payment_plans_status_idx" ON "payment_plans" USING btree ("status","final_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_installments_payment_uq" ON "plan_installments" USING btree ("payment_transaction_id");--> statement-breakpoint
CREATE INDEX "plan_installments_due_idx" ON "plan_installments" USING btree ("status","due_at");--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_installment_id_plan_installments_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."plan_installments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_transactions_installment_idx" ON "payment_transactions" USING btree ("installment_id");
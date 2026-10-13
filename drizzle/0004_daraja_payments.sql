ALTER TYPE "public"."payment_status" ADD VALUE 'expired';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'reconciliation_required';--> statement-breakpoint
ALTER TYPE "public"."refund_status" ADD VALUE 'manual_required';--> statement-breakpoint
ALTER TABLE "payment_events" ADD COLUMN "kind" text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "merchant_request_id" text;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "provider_receipt" text;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "provider_result_code" text;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "provider_result_desc" text;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "status_check_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "next_status_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD COLUMN "last_status_check_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "payment_transactions_status_check_idx" ON "payment_transactions" USING btree ("next_status_check_at") WHERE "payment_transactions"."status" IN ('created', 'pending');--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transactions_one_active_daraja_uq" ON "payment_transactions" USING btree ("booking_id") WHERE "payment_transactions"."provider" = 'daraja' AND "payment_transactions"."status" IN ('created', 'pending');--> statement-breakpoint
ALTER TABLE "payment_transactions" ADD CONSTRAINT "payment_transactions_provider_receipt_unique" UNIQUE("provider_receipt");
ALTER TYPE "public"."email_status" ADD VALUE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'delivered';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'delivery_delayed';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'bounced';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'complained';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'suppressed';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'retry_pending';--> statement-breakpoint
ALTER TYPE "public"."email_status" ADD VALUE 'skipped';--> statement-breakpoint
CREATE TABLE "email_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"type" text NOT NULL,
	"provider_message_id" text,
	"delivery_id" uuid,
	"occurred_at" timestamp with time zone,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"delivery_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "last_error_category" text;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "first_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD COLUMN "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_provider_events" ADD CONSTRAINT "email_provider_events_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_delivery_id_email_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."email_deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_provider_events_provider_event_uq" ON "email_provider_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "email_provider_events_message_idx" ON "email_provider_events" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_suppressions_email_lower_uq" ON "email_suppressions" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_deliveries_status_idx" ON "email_deliveries" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "email_deliveries_provider_message_uq" ON "email_deliveries" USING btree ("provider_message_id");
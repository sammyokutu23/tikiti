CREATE TYPE "public"."resale_listing_kind" AS ENUM('platform', 'external');--> statement-breakpoint
CREATE TYPE "public"."resale_listing_status" AS ENUM('pending_review', 'active', 'sold', 'cancelled', 'rejected', 'closed');--> statement-breakpoint
CREATE TYPE "public"."resale_payout_status" AS ENUM('held', 'disputed', 'paid', 'cancelled');--> statement-breakpoint
CREATE TABLE "resale_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resale_documents_purpose" CHECK ("resale_documents"."purpose" IN ('ticket', 'proof'))
);
--> statement-breakpoint
CREATE TABLE "resale_listings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"kind" "resale_listing_kind" NOT NULL,
	"status" "resale_listing_status" NOT NULL,
	"seller_user_id" uuid NOT NULL,
	"event_id" uuid,
	"ticket_id" uuid,
	"ticket_type_name" text NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"payout_phone" text NOT NULL,
	"external_event_name" text,
	"external_venue" text,
	"external_city" text,
	"external_starts_at" timestamp with time zone,
	"external_platform" text,
	"external_order_ref" text,
	"seller_note" text DEFAULT '' NOT NULL,
	"review_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"sold_booking_id" uuid,
	"sold_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resale_listings_reference_unique" UNIQUE("reference"),
	CONSTRAINT "resale_listings_price" CHECK ("resale_listings"."price_minor" > 0 AND "resale_listings"."price_minor" % 100 = 0),
	CONSTRAINT "resale_listings_kind_fields" CHECK (("resale_listings"."kind" = 'platform' AND "resale_listings"."ticket_id" IS NOT NULL AND "resale_listings"."event_id" IS NOT NULL) OR ("resale_listings"."kind" = 'external' AND "resale_listings"."ticket_id" IS NULL AND "resale_listings"."external_event_name" IS NOT NULL AND "resale_listings"."external_starts_at" IS NOT NULL)),
	CONSTRAINT "resale_listings_live_has_event" CHECK ("resale_listings"."status" NOT IN ('active', 'sold') OR "resale_listings"."event_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "resale_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"listing_id" uuid NOT NULL,
	"booking_id" uuid NOT NULL,
	"seller_user_id" uuid NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"payout_phone" text NOT NULL,
	"status" "resale_payout_status" DEFAULT 'held' NOT NULL,
	"release_at" timestamp with time zone NOT NULL,
	"dispute_reason" text,
	"disputed_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"payout_reference" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resale_payouts_listing_id_unique" UNIQUE("listing_id"),
	CONSTRAINT "resale_payouts_booking_id_unique" UNIQUE("booking_id"),
	CONSTRAINT "resale_payouts_amount" CHECK ("resale_payouts"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "resale_listing_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "is_external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "resale_documents" ADD CONSTRAINT "resale_documents_listing_id_resale_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."resale_listings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD CONSTRAINT "resale_listings_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD CONSTRAINT "resale_listings_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD CONSTRAINT "resale_listings_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD CONSTRAINT "resale_listings_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD CONSTRAINT "resale_listings_sold_booking_id_bookings_id_fk" FOREIGN KEY ("sold_booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_payouts" ADD CONSTRAINT "resale_payouts_listing_id_resale_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."resale_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_payouts" ADD CONSTRAINT "resale_payouts_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_payouts" ADD CONSTRAINT "resale_payouts_seller_user_id_users_id_fk" FOREIGN KEY ("seller_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_payouts" ADD CONSTRAINT "resale_payouts_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resale_documents_listing_idx" ON "resale_documents" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "resale_listings_status_idx" ON "resale_listings" USING btree ("status","event_id");--> statement-breakpoint
CREATE INDEX "resale_listings_seller_idx" ON "resale_listings" USING btree ("seller_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "resale_listings_open_ticket_uq" ON "resale_listings" USING btree ("ticket_id") WHERE "resale_listings"."status" IN ('pending_review', 'active');--> statement-breakpoint
CREATE INDEX "resale_payouts_status_idx" ON "resale_payouts" USING btree ("status","release_at");--> statement-breakpoint
CREATE INDEX "resale_payouts_seller_idx" ON "resale_payouts" USING btree ("seller_user_id");--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_resale_listing_id_resale_listings_id_fk" FOREIGN KEY ("resale_listing_id") REFERENCES "public"."resale_listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_resale_listing_idx" ON "bookings" USING btree ("resale_listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_resale_confirmed_uq" ON "bookings" USING btree ("resale_listing_id") WHERE "bookings"."status" = 'confirmed';--> statement-breakpoint
-- Supabase: block the public Data API (the app connects as the table owner, which bypasses RLS).
ALTER TABLE "resale_listings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resale_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "resale_payouts" ENABLE ROW LEVEL SECURITY;
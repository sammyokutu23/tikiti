ALTER TABLE "events" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "longitude" double precision;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "location_provider" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "location_place_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "location_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "arrival_instructions" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_coordinates_valid" CHECK (("events"."latitude" IS NULL AND "events"."longitude" IS NULL) OR ("events"."latitude" BETWEEN -90 AND 90 AND "events"."longitude" BETWEEN -180 AND 180));
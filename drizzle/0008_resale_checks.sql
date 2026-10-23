ALTER TABLE "resale_documents" ADD COLUMN "withdrawn_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resale_documents" ADD COLUMN "withdrawn_by" uuid;--> statement-breakpoint
ALTER TABLE "resale_documents" ADD COLUMN "uploaded_by" uuid;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD COLUMN "external_mpesa_code" text;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD COLUMN "check_status" text;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD COLUMN "check_result" jsonb;--> statement-breakpoint
ALTER TABLE "resale_listings" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "resale_documents" ADD CONSTRAINT "resale_documents_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resale_documents" ADD CONSTRAINT "resale_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
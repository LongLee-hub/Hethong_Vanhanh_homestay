ALTER TABLE "reviews" ADD COLUMN "room_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "dayladau_account_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "guest_name" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "listing_name" text;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "location" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "accuracy" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "checkin" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "cleanliness" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "communication" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "check_in" date;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "check_out" date;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "raw_payload" jsonb;--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_prop_date" ON "reviews" USING btree ("property_id","review_date");--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_external_id_unique" UNIQUE("external_id");
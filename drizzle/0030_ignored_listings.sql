CREATE TABLE IF NOT EXISTS "ignored_listings" (
	"dayladau_account_id" text NOT NULL,
	"listing_key" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ignored_listings_dayladau_account_id_listing_key_pk" PRIMARY KEY("dayladau_account_id","listing_key")
);
--> statement-breakpoint
ALTER TABLE "ignored_listings" ADD CONSTRAINT "ignored_listings_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;

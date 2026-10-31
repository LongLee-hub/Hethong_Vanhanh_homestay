CREATE TABLE "dayladau_payout_items" (
	"id" text PRIMARY KEY NOT NULL,
	"payout_id" text,
	"dayladau_account_id" text NOT NULL,
	"order_id" text NOT NULL,
	"listing_key" text,
	"listing_name" text,
	"guest_name" text,
	"check_in" date,
	"check_out" date,
	"order_status" text,
	"source" text,
	"gross_amount" bigint DEFAULT 0 NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"booking_id" text,
	"booking_net" bigint,
	"match_status" "payout_match_status" DEFAULT 'NOT_FOUND' NOT NULL,
	"diff_amount" bigint
);
--> statement-breakpoint
CREATE TABLE "dayladau_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"dayladau_account_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"external_id" text NOT NULL,
	"created_on_dayladau_at" timestamp with time zone NOT NULL,
	"payout_date" date NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"order_count" integer DEFAULT 0 NOT NULL,
	"items_total" bigint DEFAULT 0 NOT NULL,
	"picture_url" text,
	"transfer_ref" text,
	"note" text,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "dayladau_payouts_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "dayladau_payout_items" ADD CONSTRAINT "dayladau_payout_items_payout_id_dayladau_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."dayladau_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dayladau_payout_items" ADD CONSTRAINT "dayladau_payout_items_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dayladau_payout_items" ADD CONSTRAINT "dayladau_payout_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dayladau_payouts" ADD CONSTRAINT "dayladau_payouts_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dayladau_payouts" ADD CONSTRAINT "dayladau_payouts_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dl_payout_items_payout_order" ON "dayladau_payout_items" USING btree ("payout_id","order_id");--> statement-breakpoint
CREATE INDEX "dl_payout_items_acc" ON "dayladau_payout_items" USING btree ("dayladau_account_id");--> statement-breakpoint
CREATE INDEX "dl_payout_items_order" ON "dayladau_payout_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "dl_payout_items_booking" ON "dayladau_payout_items" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "dl_payouts_acc_date" ON "dayladau_payouts" USING btree ("dayladau_account_id","payout_date");
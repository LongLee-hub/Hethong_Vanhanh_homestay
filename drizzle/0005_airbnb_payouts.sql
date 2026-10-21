CREATE TYPE "public"."payout_match_status" AS ENUM('MATCHED', 'AMOUNT_DIFF', 'NOT_FOUND');--> statement-breakpoint
CREATE TYPE "public"."payout_parse_status" AS ENUM('OK', 'PARTIAL', 'FAILED');--> statement-breakpoint
CREATE TABLE "airbnb_payout_items" (
	"id" text PRIMARY KEY NOT NULL,
	"payout_id" text NOT NULL,
	"confirmation_code" text,
	"guest_name" text,
	"listing_name" text,
	"check_in" date,
	"check_out" date,
	"amount" bigint,
	"booking_id" text,
	"match_status" "payout_match_status" DEFAULT 'NOT_FOUND' NOT NULL,
	"diff_amount" bigint
);
--> statement-breakpoint
CREATE TABLE "airbnb_payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"gmail_account_id" text NOT NULL,
	"investor_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payout_date" date NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'VND' NOT NULL,
	"subject" text,
	"body_text" text,
	"parse_status" "payout_parse_status" NOT NULL,
	"parse_note" text
);
--> statement-breakpoint
CREATE TABLE "gmail_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"investor_id" text NOT NULL,
	"email" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"connected_by_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gmail_accounts_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "airbnb_payout_items" ADD CONSTRAINT "airbnb_payout_items_payout_id_airbnb_payouts_id_fk" FOREIGN KEY ("payout_id") REFERENCES "public"."airbnb_payouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airbnb_payout_items" ADD CONSTRAINT "airbnb_payout_items_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airbnb_payouts" ADD CONSTRAINT "airbnb_payouts_gmail_account_id_gmail_accounts_id_fk" FOREIGN KEY ("gmail_account_id") REFERENCES "public"."gmail_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airbnb_payouts" ADD CONSTRAINT "airbnb_payouts_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_accounts" ADD CONSTRAINT "gmail_accounts_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payout_items_payout" ON "airbnb_payout_items" USING btree ("payout_id");--> statement-breakpoint
CREATE INDEX "payout_items_code" ON "airbnb_payout_items" USING btree ("confirmation_code");--> statement-breakpoint
CREATE INDEX "payout_items_booking" ON "airbnb_payout_items" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payouts_account_msg" ON "airbnb_payouts" USING btree ("gmail_account_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "payouts_inv_date" ON "airbnb_payouts" USING btree ("investor_id","payout_date");
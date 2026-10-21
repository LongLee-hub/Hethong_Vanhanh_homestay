ALTER TABLE "airbnb_payout_items" ADD COLUMN "line_type" text;--> statement-breakpoint
ALTER TABLE "airbnb_payout_items" ADD COLUMN "listing_id" text;--> statement-breakpoint
ALTER TABLE "airbnb_payout_items" ADD COLUMN "usd_amount" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "airbnb_payouts" ADD COLUMN "payout_code" text;--> statement-breakpoint
ALTER TABLE "airbnb_payouts" ADD COLUMN "total_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "airbnb_payouts" ADD COLUMN "exchange_rate" numeric(14, 4);--> statement-breakpoint
CREATE INDEX "payouts_inv_code" ON "airbnb_payouts" USING btree ("investor_id","payout_code");
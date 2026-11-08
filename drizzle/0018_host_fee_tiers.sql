ALTER TABLE "investors" ADD COLUMN "fee_tiers" jsonb;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "fee_tiers" jsonb;
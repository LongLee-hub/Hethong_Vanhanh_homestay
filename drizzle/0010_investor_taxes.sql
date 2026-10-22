ALTER TABLE "investors" ADD COLUMN "vat_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "pit_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "vat_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "vat_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "pit_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "pit_amount" bigint DEFAULT 0 NOT NULL;
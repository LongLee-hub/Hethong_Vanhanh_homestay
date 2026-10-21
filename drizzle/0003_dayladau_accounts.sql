CREATE TABLE "dayladau_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"investor_id" text NOT NULL,
	"label" text NOT NULL,
	"host_id" text NOT NULL,
	"token_encrypted" text NOT NULL,
	"token_last4" text,
	"token_updated_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_status" text,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dayladau_accounts_host_id_unique" UNIQUE("host_id")
);
--> statement-breakpoint
ALTER TABLE "rooms" DROP CONSTRAINT "rooms_dayladau_room_id_unique";--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "tax_code" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "bank_account_no" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "bank_account_name" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "management_fee_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "contract_start_on" date;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "contract_end_on" date;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "contract_url" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "payout_day" integer;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "dayladau_account_id" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "dayladau_account_id" text;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "fee_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "dayladau_accounts" ADD CONSTRAINT "dayladau_accounts_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rooms_dayladau_listing" ON "rooms" USING btree ("dayladau_account_id","dayladau_room_id");--> statement-breakpoint
-- Chuyển host ID + token đang lưu trên NĐT sang tài khoản Dayladau; mọi cơ sở của NĐT dùng tài khoản đó
INSERT INTO "dayladau_accounts" ("id", "investor_id", "label", "host_id", "token_encrypted", "token_updated_at") SELECT gen_random_uuid()::text, "id", "name", "dayladau_host_id", "dayladau_token_encrypted", now() FROM "investors" WHERE "dayladau_host_id" IS NOT NULL AND "dayladau_token_encrypted" IS NOT NULL;--> statement-breakpoint
UPDATE "properties" p SET "dayladau_account_id" = a."id" FROM "dayladau_accounts" a WHERE a."investor_id" = p."investor_id";--> statement-breakpoint
UPDATE "rooms" r SET "dayladau_account_id" = p."dayladau_account_id" FROM "properties" p WHERE r."property_id" = p."id" AND r."dayladau_room_id" IS NOT NULL;--> statement-breakpoint
-- Listing gắn ở cơ sở không có tài khoản thì không còn dùng được
UPDATE "rooms" SET "dayladau_room_id" = NULL WHERE "dayladau_account_id" IS NULL;--> statement-breakpoint
-- Cảnh báo cũ có khóa theo NĐT; lần đồng bộ sau tạo lại theo khóa tài khoản
UPDATE "alerts" SET "resolved_at" = now() WHERE "resolved_at" IS NULL AND "type" IN ('UNMAPPED_ROOM', 'SYNC_FAILED');

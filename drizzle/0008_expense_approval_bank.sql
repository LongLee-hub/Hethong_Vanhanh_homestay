CREATE TYPE "public"."bank_txn_status" AS ENUM('NEW', 'RECORDED', 'IGNORED', 'INCOME');--> statement-breakpoint
CREATE TYPE "public"."expense_approval" AS ENUM('PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" text PRIMARY KEY NOT NULL,
	"bank" text NOT NULL,
	"account_no" text NOT NULL,
	"account_name" text,
	"from_date" date,
	"to_date" date,
	"opening_balance" bigint,
	"closing_balance" bigint,
	"file_name" text,
	"uploaded_by_id" text NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"statement_id" text NOT NULL,
	"account_no" text NOT NULL,
	"ref" text NOT NULL,
	"txn_at" timestamp with time zone NOT NULL,
	"booked_on" date NOT NULL,
	"debit" bigint DEFAULT 0 NOT NULL,
	"credit" bigint DEFAULT 0 NOT NULL,
	"balance" bigint,
	"counterparty" text,
	"content" text NOT NULL,
	"status" "bank_txn_status" NOT NULL,
	"note" text,
	"handled_by_id" text,
	"handled_at" timestamp with time zone
);
--> statement-breakpoint
-- Chi phí nhập trước khi có bước duyệt coi như đã duyệt (đang được tính trong quyết toán); khoản mới mặc định chờ duyệt
ALTER TABLE "expenses" ADD COLUMN "approval_status" "expense_approval" DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ALTER COLUMN "approval_status" SET DEFAULT 'PENDING';--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approved_by_id" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "reject_reason" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "updated_by_id" text;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "bank_transaction_id" text;--> statement-breakpoint
ALTER TABLE "investors" ADD COLUMN "lark_webhook_url" text;--> statement-breakpoint
ALTER TABLE "properties" ADD COLUMN "bank_codes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_txn_ref" ON "bank_transactions" USING btree ("account_no","ref");--> statement-breakpoint
CREATE INDEX "bank_txn_status" ON "bank_transactions" USING btree ("status","booked_on");--> statement-breakpoint
CREATE INDEX "expenses_approval" ON "expenses" USING btree ("approval_status");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_bank_transaction_id_unique" UNIQUE("bank_transaction_id");
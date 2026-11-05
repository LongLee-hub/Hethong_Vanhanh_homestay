CREATE TYPE "public"."attendance_shift" AS ENUM('MORNING', 'EVENING', 'OVERTIME');--> statement-breakpoint
CREATE TABLE "housekeeper_pay" (
	"user_id" text PRIMARY KEY NOT NULL,
	"morning_monthly" bigint DEFAULT 0 NOT NULL,
	"evening_monthly" bigint DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"month" text NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "attendance_user_date";--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "shift" "attendance_shift" DEFAULT 'MORNING' NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "check_out_photo_url" text;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "accuracy_m" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "housekeeper_pay" ADD CONSTRAINT "housekeeper_pay_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_adjustments" ADD CONSTRAINT "payroll_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_adj_month" ON "payroll_adjustments" USING btree ("month","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_user_date_shift" ON "attendance" USING btree ("user_id","date","shift");
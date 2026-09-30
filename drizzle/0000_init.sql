CREATE TYPE "public"."booking_source" AS ENUM('DAYLADAU', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('CONFIRMED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."cost_scope" AS ENUM('DIRECT', 'COMMON');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('UNPAID', 'PAID');--> statement-breakpoint
CREATE TYPE "public"."priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('ADMIN', 'INVESTOR', 'MANAGER', 'ACCOUNTANT', 'HOUSEKEEPER');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('DRAFT', 'LOCKED');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."task_type" AS ENUM('CLEANING', 'CHECKIN', 'CHECKOUT', 'MAINTENANCE', 'PURCHASE', 'BAD_REVIEW', 'INVENTORY', 'RECURRING');--> statement-breakpoint
CREATE TABLE "adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"applied_month" text NOT NULL,
	"original_month" text NOT NULL,
	"booking_id" text,
	"amount" bigint DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"key" text NOT NULL,
	"property_id" text,
	"month" text,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "alerts_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"property_id" text NOT NULL,
	"date" date NOT NULL,
	"check_in_at" timestamp with time zone NOT NULL,
	"check_out_at" timestamp with time zone,
	"photo_url" text
);
--> statement-breakpoint
CREATE TABLE "booking_change_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_by" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "booking_nights" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"property_id" text NOT NULL,
	"room_id" text NOT NULL,
	"night_date" date NOT NULL,
	"net_amount" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"source" "booking_source" NOT NULL,
	"external_id" text,
	"property_id" text NOT NULL,
	"room_id" text NOT NULL,
	"channel" text NOT NULL,
	"guest_name" text,
	"booked_at" date,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"gross_amount" bigint DEFAULT 0 NOT NULL,
	"commission_amount" bigint DEFAULT 0 NOT NULL,
	"net_amount" bigint DEFAULT 0 NOT NULL,
	"status" "booking_status" NOT NULL,
	"transfer_proof_url" text,
	"raw_payload" jsonb,
	"created_by_id" text,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "bookings_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "checklist_results" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"results" jsonb NOT NULL,
	CONSTRAINT "checklist_results_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"items" text[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_categories" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"scope" "cost_scope" NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text,
	"category_id" text NOT NULL,
	"month" text NOT NULL,
	"incurred_on" date NOT NULL,
	"amount" bigint DEFAULT 0 NOT NULL,
	"description" text NOT NULL,
	"payment_status" "payment_status" DEFAULT 'UNPAID' NOT NULL,
	"paid_at" timestamp with time zone,
	"receipt_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"task_id" text,
	"created_by_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "investors" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"dayladau_host_id" text,
	"dayladau_token_encrypted" text,
	CONSTRAINT "investors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "month_periods" (
	"month" text PRIMARY KEY NOT NULL,
	"common_costs_finalized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" text PRIMARY KEY NOT NULL,
	"investor_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"investment_amount" bigint DEFAULT 0 NOT NULL,
	"investment_start_month" text,
	"occupancy_kpi_pct" integer DEFAULT 70 NOT NULL,
	"variable_cost_per_night" bigint DEFAULT 0 NOT NULL,
	"fixed_cost_monthly" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"booking_id" text,
	"channel" text NOT NULL,
	"score" numeric(4, 2) NOT NULL,
	"review_date" date NOT NULL,
	"content" text
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"name" text NOT NULL,
	"dayladau_room_id" text,
	"opened_on" date NOT NULL,
	"closed_on" date,
	CONSTRAINT "rooms_dayladau_room_id_unique" UNIQUE("dayladau_room_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_lines" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_id" text NOT NULL,
	"property_id" text NOT NULL,
	"room_count" integer NOT NULL,
	"sold_nights" integer NOT NULL,
	"available_nights" integer NOT NULL,
	"revenue" bigint DEFAULT 0 NOT NULL,
	"adjustments" bigint DEFAULT 0 NOT NULL,
	"direct_cost" bigint DEFAULT 0 NOT NULL,
	"common_cost_alloc" bigint DEFAULT 0 NOT NULL,
	"profit" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlement_unlock_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"settlement_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_user_id" text NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" text PRIMARY KEY NOT NULL,
	"investor_id" text NOT NULL,
	"month" text NOT NULL,
	"status" "settlement_status" NOT NULL,
	"total_revenue" bigint DEFAULT 0 NOT NULL,
	"total_direct_cost" bigint DEFAULT 0 NOT NULL,
	"total_common_cost" bigint DEFAULT 0 NOT NULL,
	"total_profit" bigint DEFAULT 0 NOT NULL,
	"management_fee" bigint DEFAULT 0 NOT NULL,
	"investor_net" bigint DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by_id" text
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"errors" jsonb
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"room_id" text,
	"booking_id" text,
	"type" "task_type" NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assigned_by_id" text NOT NULL,
	"assignee_id" text,
	"due_at" timestamp with time zone NOT NULL,
	"priority" "priority" DEFAULT 'MEDIUM' NOT NULL,
	"status" "task_status" DEFAULT 'TODO' NOT NULL,
	"completed_at" timestamp with time zone,
	"photo_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"recurrence_rule" text,
	"template_id" text
);
--> statement-breakpoint
CREATE TABLE "user_property_access" (
	"user_id" text NOT NULL,
	"property_id" text NOT NULL,
	CONSTRAINT "user_property_access_user_id_property_id_pk" PRIMARY KEY("user_id","property_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"password_hash" text NOT NULL,
	"role" "role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_change_logs" ADD CONSTRAINT "booking_change_logs_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_nights" ADD CONSTRAINT "booking_nights_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_results" ADD CONSTRAINT "checklist_results_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_expense_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."expense_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investors" ADD CONSTRAINT "investors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_lines" ADD CONSTRAINT "settlement_lines_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_unlock_logs" ADD CONSTRAINT "settlement_unlock_logs_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property_access" ADD CONSTRAINT "user_property_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_property_access" ADD CONSTRAINT "user_property_access_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adj_prop_month" ON "adjustments" USING btree ("property_id","applied_month");--> statement-breakpoint
CREATE UNIQUE INDEX "attendance_user_date" ON "attendance" USING btree ("user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "nights_booking_date" ON "booking_nights" USING btree ("booking_id","night_date");--> statement-breakpoint
CREATE INDEX "nights_prop_date" ON "booking_nights" USING btree ("property_id","night_date");--> statement-breakpoint
CREATE INDEX "bookings_prop_checkin" ON "bookings" USING btree ("property_id","check_in");--> statement-breakpoint
CREATE INDEX "expenses_month_prop" ON "expenses" USING btree ("month","property_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_inv_month" ON "settlements" USING btree ("investor_id","month");--> statement-breakpoint
CREATE INDEX "tasks_prop_status_due" ON "tasks" USING btree ("property_id","status","due_at");
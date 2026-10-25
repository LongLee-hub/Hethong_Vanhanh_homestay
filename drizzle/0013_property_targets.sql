CREATE TABLE "property_targets" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"month" text NOT NULL,
	"revenue" bigint DEFAULT 0 NOT NULL,
	"occupancy_pct" numeric(5, 2) DEFAULT 0 NOT NULL,
	"adr" bigint DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "property_targets" ADD CONSTRAINT "property_targets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_targets" ADD CONSTRAINT "property_targets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "property_targets_property_month" ON "property_targets" USING btree ("property_id","month");
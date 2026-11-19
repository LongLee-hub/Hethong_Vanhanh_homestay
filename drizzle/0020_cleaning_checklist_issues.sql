CREATE TABLE "facility_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"property_id" text NOT NULL,
	"room_id" text,
	"category" text NOT NULL,
	"description" text NOT NULL,
	"photo_url" text,
	"reported_by_id" text NOT NULL,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assignee_id" text,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" text,
	"resolution_note" text
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN "support" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "completed_by_id" text;--> statement-breakpoint
ALTER TABLE "facility_issues" ADD CONSTRAINT "facility_issues_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_issues" ADD CONSTRAINT "facility_issues_reported_by_id_users_id_fk" FOREIGN KEY ("reported_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_issues" ADD CONSTRAINT "facility_issues_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_issues_prop_open" ON "facility_issues" USING btree ("property_id","resolved_at");
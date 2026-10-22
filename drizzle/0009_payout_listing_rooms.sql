CREATE TABLE "airbnb_listing_rooms" (
	"investor_id" text NOT NULL,
	"listing_key" text NOT NULL,
	"room_id" text NOT NULL,
	CONSTRAINT "airbnb_listing_rooms_investor_id_listing_key_pk" PRIMARY KEY("investor_id","listing_key")
);
--> statement-breakpoint
ALTER TABLE "airbnb_listing_rooms" ADD CONSTRAINT "airbnb_listing_rooms_investor_id_investors_id_fk" FOREIGN KEY ("investor_id") REFERENCES "public"."investors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airbnb_listing_rooms" ADD CONSTRAINT "airbnb_listing_rooms_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;
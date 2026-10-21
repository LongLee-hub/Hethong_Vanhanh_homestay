CREATE TABLE "room_listings" (
	"room_id" text NOT NULL,
	"dayladau_account_id" text NOT NULL,
	"listing_key" text NOT NULL,
	CONSTRAINT "room_listings_dayladau_account_id_listing_key_pk" PRIMARY KEY("dayladau_account_id","listing_key")
);
--> statement-breakpoint
ALTER TABLE "room_listings" ADD CONSTRAINT "room_listings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_listings" ADD CONSTRAINT "room_listings_dayladau_account_id_dayladau_accounts_id_fk" FOREIGN KEY ("dayladau_account_id") REFERENCES "public"."dayladau_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "room_listings_room" ON "room_listings" USING btree ("room_id");
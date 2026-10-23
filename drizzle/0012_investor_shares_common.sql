-- Chi phí chung (Unix) chỉ chia cho cơ sở của NĐT bật "Chịu chi phí chung". Bật sẵn cho Unixstay.
ALTER TABLE "investors" ADD COLUMN "shares_common_cost" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "investors" SET "shares_common_cost" = true WHERE "name" ILIKE '%unix%';

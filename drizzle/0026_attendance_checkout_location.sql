-- Kết thúc ca cũng chụp ảnh in giờ và vị trí như vào ca: lưu tọa độ lúc chụp ảnh ra ca.
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_out_lat" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_out_lng" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_out_accuracy_m" integer;

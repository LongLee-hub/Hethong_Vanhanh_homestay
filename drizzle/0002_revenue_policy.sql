CREATE TYPE "public"."night_kind" AS ENUM('NIGHT', 'HOURLY', 'CANCEL_FEE');--> statement-breakpoint
ALTER TABLE "booking_nights" ADD COLUMN "kind" "night_kind" DEFAULT 'NIGHT' NOT NULL;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "rental_type" text;--> statement-breakpoint
-- Quy chế doanh thu: lấy loại thuê từ dữ liệu Dayladau đã lưu
UPDATE "bookings" SET "rental_type" = "raw_payload"->'reservation'->'subtotal_detail_v2'->>'type_rental' WHERE "source" = 'DAYLADAU';--> statement-breakpoint
-- Thuê giờ: gộp về một lượt vào ngày nhận phòng
DELETE FROM "booking_nights" n USING "bookings" b WHERE n."booking_id" = b."id" AND b."status" = 'CONFIRMED' AND b."rental_type" IN ('hourly_rental', 'special_offer_time_rental') AND n."night_date" <> b."check_in";--> statement-breakpoint
UPDATE "booking_nights" n SET "kind" = 'HOURLY', "net_amount" = b."net_amount" FROM "bookings" b WHERE n."booking_id" = b."id" AND b."status" = 'CONFIRMED' AND b."rental_type" IN ('hourly_rental', 'special_offer_time_rental');--> statement-breakpoint
-- Đơn hủy còn tiền: là phí hủy, không phải đêm bán
UPDATE "booking_nights" n SET "kind" = 'CANCEL_FEE' FROM "bookings" b WHERE n."booking_id" = b."id" AND b."status" = 'CANCELLED';

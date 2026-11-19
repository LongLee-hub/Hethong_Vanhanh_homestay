ALTER TABLE "bookings" ADD COLUMN "check_in_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "check_out_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "bookings_room_checkin_at" ON "bookings" USING btree ("room_id","check_in_at");--> statement-breakpoint
-- Lấy giờ nhận / trả phòng của đơn Dayladau đã có từ dữ liệu gốc (reservation.start_time / end_time).
-- Nhận Unix giây/mili-giây và ISO có giờ (không ghi múi giờ thì coi là giờ Việt Nam); chỉ có ngày thì để trống.
UPDATE "bookings" b SET
  "check_in_at" = CASE
    WHEN x.si ~ '^\d{12,13}$' THEN to_timestamp(x.si::bigint / 1000.0)
    WHEN x.si ~ '^\d{9,11}$' THEN to_timestamp(x.si::bigint)
    WHEN x.si ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$' THEN x.si::timestamptz
    WHEN x.si ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$' THEN (x.si || '+07:00')::timestamptz
  END,
  "check_out_at" = CASE
    WHEN x.so ~ '^\d{12,13}$' THEN to_timestamp(x.so::bigint / 1000.0)
    WHEN x.so ~ '^\d{9,11}$' THEN to_timestamp(x.so::bigint)
    WHEN x.so ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$' THEN x.so::timestamptz
    WHEN x.so ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$' THEN (x.so || '+07:00')::timestamptz
  END
FROM (
  SELECT "id", "raw_payload" -> 'reservation' ->> 'start_time' AS si, "raw_payload" -> 'reservation' ->> 'end_time' AS so
  FROM "bookings" WHERE "source" = 'DAYLADAU' AND "raw_payload" IS NOT NULL
) x
WHERE b."id" = x."id";

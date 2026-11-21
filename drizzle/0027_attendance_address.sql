-- Ảnh chấm công in địa chỉ (tra từ GPS) thay cho tọa độ; lưu lại địa chỉ đó để xem trong bảng ngày công.
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_in_address" text;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "check_out_address" text;

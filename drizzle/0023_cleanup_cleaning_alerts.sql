-- Lần chạy cảnh báo dọn phòng đầu tiên (19/11/2026) tính cả việc dọn tồn từ nhiều tháng trước (chưa ai đóng vì trước đó
-- chưa dùng app dọn phòng) thành "Dọn ngay". Đóng các cảnh báo đó và xóa thông báo chưa xem tương ứng;
-- lần chạy kế tiếp (đã sửa) chỉ tạo lại cảnh báo đúng.
UPDATE "alerts" SET "resolved_at" = now() WHERE "type" = 'CLEANING_URGENT' AND "resolved_at" IS NULL;--> statement-breakpoint
DELETE FROM "notifications" WHERE "key" LIKE 'CLEANING_URGENT:%' AND "read_at" IS NULL;

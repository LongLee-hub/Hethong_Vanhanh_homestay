-- Chi phí ghi nhận từ sao kê: tháng hạch toán = tháng trả tiền (ngày hạch toán trên sao kê),
-- không còn theo "t8"/"t9" trong nội dung. Chuyển các khoản đã ghi nhận theo quy tắc cũ.
-- Bỏ qua khoản mà tháng cũ hoặc tháng mới đã khóa sổ (của NĐT sở hữu cơ sở; chi phí chung: bất kỳ NĐT nào),
-- để không lệch với số đã chốt — các khoản đó Admin mở khóa sổ rồi sửa tay.
UPDATE "expenses" e
SET "month" = to_char(bt."booked_on", 'YYYY-MM')
FROM "bank_transactions" bt
WHERE bt."id" = e."bank_transaction_id"
  AND e."month" <> to_char(bt."booked_on", 'YYYY-MM')
  AND NOT EXISTS (
    SELECT 1 FROM "settlements" s
    WHERE s."status" = 'LOCKED'
      AND s."month" IN (e."month", to_char(bt."booked_on", 'YYYY-MM'))
      AND (e."property_id" IS NULL OR s."investor_id" = (SELECT p."investor_id" FROM "properties" p WHERE p."id" = e."property_id"))
  );

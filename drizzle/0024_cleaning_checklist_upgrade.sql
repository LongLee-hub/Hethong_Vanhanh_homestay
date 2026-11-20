-- Việc dọn phòng còn mở được sinh trước khi có checklist ảnh (19/11/2026) vẫn mang checklist cũ (không có mục bắt buộc ảnh).
-- Đổi sang checklist mới cho những việc chưa tick mục nào; việc đã làm dở giữ nguyên.
UPDATE "checklist_results" SET "results" = '[{"item": "Thay ga, vỏ gối, khăn tắm", "done": false, "needPhoto": true}, {"item": "Vệ sinh nhà tắm, bồn cầu", "done": false, "needPhoto": true}, {"item": "Hút bụi, lau sàn", "done": false, "needPhoto": true}, {"item": "Bổ sung nước, trà, đồ vệ sinh cá nhân", "done": false}, {"item": "Kiểm tra điều hòa, đèn, remote", "done": false}, {"item": "Đổ rác, thay túi rác", "done": false}, {"item": "Kiểm tra chìa khoá / thẻ từ đủ và đúng chỗ", "done": false, "needPhoto": true}]'::jsonb
WHERE "task_id" IN (SELECT "id" FROM "tasks" WHERE "type" = 'CLEANING' AND "status" IN ('TODO', 'IN_PROGRESS'))
  AND NOT jsonb_path_exists("results", '$[*] ? (@.needPhoto == true)')
  AND NOT jsonb_path_exists("results", '$[*] ? (@.done == true)');

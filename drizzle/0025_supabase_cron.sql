-- Hẹn giờ chạy ngay trong Supabase (pg_cron + pg_net) thay cho lịch GitHub Actions: GitHub bỏ/dồn lịch dày,
-- thực tế chỉ chạy vài lần mỗi ngày nên đơn đặt trong ngày và cảnh báo "Dọn ngay" về trễ hàng giờ.
-- Khóa gọi các route cron sinh ngẫu nhiên, nằm trong schema app_private (API công khai của Supabase chỉ mở schema public),
-- job đọc khóa lúc chạy nên khóa không nằm trong repo hay trong bảng cron.job. Route kiểm tra khóa: lib/server.ts scheduledAuthorized.
-- Máy không có pg_cron/pg_net (PGlite khi test, Postgres tự dựng) thì bỏ qua phần hẹn giờ, không làm hỏng migration.
CREATE SCHEMA IF NOT EXISTS "app_private";--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_private"."cron_secrets" ("name" text PRIMARY KEY, "value" text NOT NULL);--> statement-breakpoint
REVOKE ALL ON SCHEMA "app_private" FROM PUBLIC;--> statement-breakpoint
INSERT INTO "app_private"."cron_secrets" ("name", "value")
VALUES ('http', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog';
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions';
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Bỏ qua hẹn giờ trong DB (không có pg_cron/pg_net): %', SQLERRM;
    RETURN;
  END;
  -- Giờ pg_cron là UTC. Lấy đơn 15 phút/lần cả ngày đêm; cảnh báo dọn phòng 5 phút/lần.
  EXECUTE $q$SELECT cron.schedule('loci-sync-bookings', '*/15 * * * *', $job$
    SELECT net.http_get(
      url := 'https://www.baocaodau.com/api/cron/sync-bookings',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT value FROM app_private.cron_secrets WHERE name = 'http')),
      timeout_milliseconds := 300000
    )
  $job$)$q$;
  EXECUTE $q$SELECT cron.schedule('loci-cleaning-alerts', '*/5 * * * *', $job$
    SELECT net.http_get(
      url := 'https://www.baocaodau.com/api/cron/cleaning',
      headers := jsonb_build_object('Authorization', 'Bearer ' || (SELECT value FROM app_private.cron_secrets WHERE name = 'http')),
      timeout_milliseconds := 120000
    )
  $job$)$q$;
END $$;

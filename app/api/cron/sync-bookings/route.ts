import { NextResponse } from "next/server";
import { and, gt, isNull, sql } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb, type DB } from "@/lib/db";
import { rowsOf } from "@/lib/db/rows";
import { syncRuns } from "@/lib/db/schema";
import { syncBookings } from "@/lib/dayladau/sync";
import { generateCleaningTasks } from "@/lib/services/tasks";
import { scheduledAuthorized } from "@/lib/server";

export const maxDuration = 300;

// Lấy đơn Dayladau dày trong ngày (15 phút/lần) để đơn đặt trong ngày về kịp.
// Gọi từ pg_cron của Supabase (drizzle/0025_supabase_cron.sql); GitHub Actions (.github/workflows/sync-bookings.yml) giữ làm
// dự phòng và để bấm chạy tay, vì lịch GitHub thực tế chỉ chạy vài lần/ngày. Vercel gói Hobby chỉ cho cron 1 lần/ngày.
// Bản nhẹ: chỉ lấy đơn + sinh việc dọn phòng hôm nay/ngày mai (đơn mới trong ngày cần có việc dọn để cảnh báo "Dọn ngay" chạy).
// Đánh giá, tổng hợp tháng, cảnh báo chung vẫn chạy một lần lúc 6h ở /api/cron/sync.

/** Một lượt đồng bộ khác (6h sáng, Admin bấm "Đồng bộ ngay", lịch khác) đang chạy thì bỏ qua lượt này. */
const RUNNING_WINDOW_MS = 5 * 60_000;

/** Vài lượt chạy gần nhất của lịch pg_cron, để xem lịch trong DB có chạy đều không (không có pg_cron thì bỏ qua). */
async function schedulerStatus(db: DB) {
  const runs = await db
    .execute(sql`SELECT j.jobname, d.status, d.start_time FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid ORDER BY d.start_time DESC LIMIT 6`)
    .then((r) => rowsOf<{ jobname: string; status: string; start_time: string }>(r))
    .catch((e: Error) => ({ unavailable: e.message }));
  // Mã HTTP các lần pg_net gọi app gần nhất (200 = route chạy xong; lỗi mạng/timeout nằm ở error_msg)
  const http = await db
    .execute(sql`SELECT status_code, timed_out, error_msg, created FROM net._http_response ORDER BY created DESC LIMIT 6`)
    .then((r) => rowsOf<{ status_code: number | null; timed_out: boolean | null; error_msg: string | null; created: string }>(r))
    .catch(() => null);
  return { runs, http };
}

export async function GET(req: Request) {
  if (!(await scheduledAuthorized(req, ["SYNC_CRON_TOKEN", "CLEANING_CRON_TOKEN"]))) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const db = getDb();
  const running = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(isNull(syncRuns.finishedAt), gt(syncRuns.startedAt, new Date(Date.now() - RUNNING_WINDOW_MS))))
    .limit(1);
  if (running.length) return NextResponse.json({ skipped: "Đang có lượt đồng bộ khác chạy", scheduler: await schedulerStatus(db) });

  const sync = await syncBookings(db);
  const today = D.todayVN();
  const cleaning = await generateCleaningTasks(db, today, D.addDays(today, 1)).catch((e: Error) => ({ error: e.message }));
  return NextResponse.json({ sync, cleaning, scheduler: await schedulerStatus(db) });
}

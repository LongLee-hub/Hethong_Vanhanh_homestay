import { NextResponse } from "next/server";
import { and, gt, isNull } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { syncRuns } from "@/lib/db/schema";
import { syncBookings } from "@/lib/dayladau/sync";
import { generateCleaningTasks } from "@/lib/services/tasks";
import { cronAuthorized } from "@/lib/server";

export const maxDuration = 300;

// Lấy đơn Dayladau dày trong ngày (15 phút/lần, 6h–24h giờ VN) để đơn đặt trong ngày về kịp.
// Gọi từ GitHub Actions (.github/workflows/sync-bookings.yml) vì Vercel gói Hobby chỉ cho cron 1 lần/ngày.
// Bản nhẹ: chỉ lấy đơn + sinh việc dọn phòng hôm nay/ngày mai (đơn mới trong ngày cần có việc dọn để cảnh báo "Dọn ngay" chạy).
// Đánh giá, tổng hợp tháng, cảnh báo chung vẫn chạy một lần lúc 6h ở /api/cron/sync.
// Khóa: CRON_SECRET, SYNC_CRON_TOKEN, hoặc dùng chung CLEANING_CRON_TOKEN (đã có sẵn cho cảnh báo dọn phòng).
function authorized(req: Request) {
  if (cronAuthorized(req)) return true;
  const auth = req.headers.get("authorization");
  return [process.env.SYNC_CRON_TOKEN, process.env.CLEANING_CRON_TOKEN].some((t) => {
    const token = t?.trim();
    return !!token && token.length >= 24 && auth === `Bearer ${token}`;
  });
}

/** Một lượt đồng bộ khác (6h sáng, Admin bấm "Đồng bộ ngay") đang chạy thì bỏ qua lượt này. */
const RUNNING_WINDOW_MS = 5 * 60_000;

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const db = getDb();
  const running = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(and(isNull(syncRuns.finishedAt), gt(syncRuns.startedAt, new Date(Date.now() - RUNNING_WINDOW_MS))))
    .limit(1);
  if (running.length) return NextResponse.json({ skipped: "Đang có lượt đồng bộ khác chạy" });

  const sync = await syncBookings(db);
  const today = D.todayVN();
  const cleaning = await generateCleaningTasks(db, today, D.addDays(today, 1)).catch((e: Error) => ({ error: e.message }));
  return NextResponse.json({ sync, cleaning });
}

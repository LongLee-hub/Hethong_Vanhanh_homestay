import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeCleaningAlerts } from "@/lib/services/cleaning";
import { scheduledAuthorized } from "@/lib/server";

// Cảnh báo dọn phòng: phòng sắp có khách mà chưa dọn xong, sự cố cơ sở vật chất mở quá 24 giờ.
// Gọi 5 phút một lần từ pg_cron của Supabase (drizzle/0025_supabase_cron.sql); GitHub Actions
// (.github/workflows/cleaning-alerts.yml, Bearer CLEANING_CRON_TOKEN) giữ làm dự phòng.
export async function GET(req: Request) {
  if (!(await scheduledAuthorized(req, ["CLEANING_CRON_TOKEN"]))) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  return NextResponse.json(await computeCleaningAlerts(getDb()));
}

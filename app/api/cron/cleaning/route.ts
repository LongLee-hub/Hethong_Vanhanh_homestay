import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeCleaningAlerts } from "@/lib/services/cleaning";
import { cronAuthorized } from "@/lib/server";

// Cảnh báo dọn phòng: phòng sắp có khách mà chưa dọn xong, sự cố cơ sở vật chất mở quá 24 giờ.
// Gọi 5 phút một lần từ GitHub Actions (.github/workflows/cleaning-alerts.yml) với header
// Authorization: Bearer CLEANING_CRON_TOKEN (khóa riêng cho việc này), hoặc CRON_SECRET như các route cron khác.
function authorized(req: Request) {
  const token = process.env.CLEANING_CRON_TOKEN?.trim();
  return cronAuthorized(req) || (!!token && token.length >= 24 && req.headers.get("authorization") === `Bearer ${token}`);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  return NextResponse.json(await computeCleaningAlerts(getDb()));
}

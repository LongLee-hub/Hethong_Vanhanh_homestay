import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeCleaningAlerts } from "@/lib/services/cleaning";
import { cronAuthorized } from "@/lib/server";

// Cảnh báo dọn phòng: phòng sắp có khách mà chưa dọn xong, sự cố cơ sở vật chất mở quá 24 giờ.
// Gọi 5–10 phút một lần từ dịch vụ hẹn giờ ngoài (Vercel Cron gói Pro, cron-job.org…) với header Authorization: Bearer CRON_SECRET.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  return NextResponse.json(await computeCleaningAlerts(getDb()));
}

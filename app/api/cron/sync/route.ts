import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncBookings } from "@/lib/dayladau/sync";
import { syncReviews } from "@/lib/dayladau/reviews";
import { sendMonthlyReviewDigest } from "@/lib/services/reviews";
import { computeAlerts } from "@/lib/services/alerts";
import { currentUser, cronAuthorized } from "@/lib/server";

export const maxDuration = 300;

// Vercel Cron gọi GET kèm "Authorization: Bearer $CRON_SECRET" lúc 06:00 giờ VN; Admin gọi POST ("Đồng bộ ngay").
async function run() {
  const db = getDb();
  const sync = await syncBookings(db);
  // Đánh giá đồng bộ sau đơn; lỗi ở đây không làm hỏng phần đồng bộ đơn đã xong
  const reviews = await syncReviews(db).catch((e: Error) => ({ error: e.message }));
  const reviewDigest = await sendMonthlyReviewDigest(db).catch((e: Error) => ({ error: e.message }));
  const alerts = await computeAlerts(db);
  // Email payout Gmail đọc riêng lúc 15:00 giờ VN (/api/cron/payouts, lib/scheduler.ts)
  return NextResponse.json({ sync, reviews, reviewDigest, alerts });
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  return run();
}

export async function POST() {
  const u = await currentUser();
  if (u?.role !== "ADMIN") return NextResponse.json({ error: "Chỉ Admin được đồng bộ thủ công" }, { status: 403 });
  return run();
}

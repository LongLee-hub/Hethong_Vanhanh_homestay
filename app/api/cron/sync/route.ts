import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncBookings } from "@/lib/dayladau/sync";
import { computeAlerts } from "@/lib/services/alerts";
import { syncPayouts } from "@/lib/airbnb/payouts";
import { gmailConfigured } from "@/lib/gmail/oauth";
import { currentUser, cronAuthorized } from "@/lib/server";

export const maxDuration = 300;

// Vercel Cron gọi GET kèm "Authorization: Bearer $CRON_SECRET" lúc 06:00 giờ VN; Admin gọi POST ("Đồng bộ ngay").
async function run() {
  const db = getDb();
  const sync = await syncBookings(db);
  const alerts = await computeAlerts(db);
  // Payout Airbnb đọc sau đơn Dayladau để khớp được cả đơn vừa đồng bộ
  const payouts = gmailConfigured() ? await syncPayouts(db).catch((e) => ({ error: (e as Error).message })) : null;
  return NextResponse.json({ sync, alerts, payouts });
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

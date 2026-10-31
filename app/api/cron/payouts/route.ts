import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncPayouts } from "@/lib/airbnb/payouts";
import { syncDayladauPayouts } from "@/lib/dayladau/payouts";
import { cronAuthorized } from "@/lib/server";

export const maxDuration = 300;

// Vercel Cron gọi lúc 15:00 giờ VN: đọc email payout Airbnb trong Gmail của mọi NĐT, rồi phiếu thanh toán Dayladau.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  const db = getDb();
  const airbnb = await syncPayouts(db);
  // Lỗi phần Dayladau không làm hỏng kết quả payout Airbnb đã xong
  const dayladau = await syncDayladauPayouts(db).catch((e: Error) => ({ error: e.message }));
  return NextResponse.json({ airbnb, dayladau });
}

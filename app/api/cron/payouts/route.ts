import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { syncPayouts } from "@/lib/airbnb/payouts";
import { cronAuthorized } from "@/lib/server";

export const maxDuration = 300;

// Vercel Cron gọi lúc 15:00 giờ VN: đọc email payout Airbnb trong Gmail của mọi NĐT.
export async function GET(req: Request) {
  if (!cronAuthorized(req)) return NextResponse.json({ error: "Không có quyền" }, { status: 401 });
  return NextResponse.json(await syncPayouts(getDb()));
}

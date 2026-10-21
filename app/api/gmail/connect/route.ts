import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/server";
import { canManageGmail } from "@/lib/airbnb/payouts";
import { appOrigin, authUrl, gmailConfigured, signState } from "@/lib/gmail/oauth";

// Bấm "Kết nối Gmail" → chuyển sang trang đồng ý quyền của Google (chỉ đọc thư).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = appOrigin(req);
  const back = (msg: string) => NextResponse.redirect(new URL(`/payouts?gmail=${encodeURIComponent(msg)}`, origin));
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));
  if (!gmailConfigured()) return back("Máy chủ chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  const investorId = url.searchParams.get("investorId") ?? "";
  if (!investorId || !(await canManageGmail(getDb(), user, investorId))) return back("Bạn không có quyền kết nối Gmail cho nhà đầu tư này");
  return NextResponse.redirect(authUrl(origin, await signState({ userId: user.id, investorId })));
}

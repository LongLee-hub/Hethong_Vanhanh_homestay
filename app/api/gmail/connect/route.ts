import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/server";
import { canManageGmail } from "@/lib/airbnb/payouts";
import { appOrigin, authUrl, signState } from "@/lib/gmail/oauth";
import { googleReady, loadGoogleConfig } from "@/lib/gmail/config";

// Bấm "Kết nối Gmail" → chuyển sang trang đồng ý quyền của Google (chỉ đọc thư).
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cfg = await loadGoogleConfig(getDb());
  const origin = appOrigin(req, cfg);
  const back = (msg: string) => NextResponse.redirect(new URL(`/payouts?gmail=${encodeURIComponent(msg)}`, origin));
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));
  if (!googleReady(cfg)) return back("Chưa cài đặt kết nối Google: Admin nhập Client ID và Client Secret ở mục Cài đặt Google");
  const investorId = url.searchParams.get("investorId") ?? "";
  if (!investorId || !(await canManageGmail(getDb(), user, investorId))) return back("Bạn không có quyền kết nối Gmail cho nhà đầu tư này");
  return NextResponse.redirect(authUrl(cfg, origin, await signState({ userId: user.id, investorId })));
}

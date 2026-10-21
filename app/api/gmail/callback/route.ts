import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { HttpError } from "@/lib/auth/access";
import { currentUser } from "@/lib/server";
import { saveGmailConnection, syncPayouts } from "@/lib/airbnb/payouts";
import { appOrigin, exchangeCode, GMAIL_SCOPE, verifyState } from "@/lib/gmail/oauth";
import { loadGoogleConfig } from "@/lib/gmail/config";

export const maxDuration = 300;

// Google gọi lại sau khi người dùng đồng ý: lưu refresh token (mã hóa), đọc ngay email payout lần đầu.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cfg = await loadGoogleConfig(getDb());
  const origin = appOrigin(req, cfg);
  const back = (msg: string, ok = false) => NextResponse.redirect(new URL(`/payouts?${ok ? "connected" : "gmail"}=${encodeURIComponent(msg)}`, origin));
  const user = await currentUser();
  if (!user) return NextResponse.redirect(new URL("/login", origin));
  if (url.searchParams.get("error")) return back("Đã hủy kết nối Gmail");
  const state = await verifyState(url.searchParams.get("state"));
  if (!state || state.userId !== user.id) return back("Phiên kết nối Gmail hết hạn, bấm Kết nối lại");
  const code = url.searchParams.get("code");
  if (!code) return back("Google không trả mã ủy quyền");
  try {
    const t = await exchangeCode(cfg, origin, code);
    if (!t.scope.split(" ").includes(GMAIL_SCOPE)) return back("Cần tích chọn quyền đọc Gmail ở màn hình Google");
    const db = getDb();
    const acc = await saveGmailConnection(db, user, { investorId: state.investorId, email: t.email, refreshToken: t.refreshToken });
    const sum = await syncPayouts(db, { accountIds: [acc.id] });
    const err = sum.errors[0]?.message;
    return err ? back(`Đã kết nối ${t.email} nhưng đọc thư lỗi: ${err}`) : back(`Đã kết nối ${t.email}, đọc được ${sum.created} email payout`, true);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    return back((e as Error).message || "Kết nối Gmail lỗi");
  }
}

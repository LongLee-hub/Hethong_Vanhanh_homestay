// Tiện ích phía máy chủ cho trang và route API.
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "./db";
import { HttpError, type SessionUser } from "./auth/access";
import { SESSION_COOKIE, readSessionToken, refreshUser } from "./auth/session";
import { getSetting } from "./services/settings";

// cache: layout và trang cùng gọi trong một lượt tải, chỉ hỏi DB một lần
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return refreshUser(getDb(), await readSessionToken(token));
});

/** Dùng trong trang: chưa đăng nhập thì chuyển về /login. */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) {
    // Phiên hết hạn: giữ trang đang mở để đăng nhập xong quay lại (middleware gắn sẵn header x-pathname nếu có)
    const path = (await headers()).get("x-loci-path");
    redirect(path && path !== "/" ? `/login?next=${encodeURIComponent(path)}` : "/login");
  }
  return u;
}

/** Bọc route API: xác thực, bắt lỗi nghiệp vụ, trả JSON. BigInt/number giữ nguyên. */
export function api<T>(handler: (ctx: { user: SessionUser; req: Request; params: Record<string, string> }) => Promise<T>) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }) => {
    try {
      const user = await currentUser();
      if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
      const data = await handler({ user, req, params: await ctx.params });
      return NextResponse.json(data ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ error: "Dữ liệu không hợp lệ", issues: e.issues }, { status: 400 });
      console.error(e);
      return NextResponse.json({ error: "Lỗi máy chủ" }, { status: 500 });
    }
  };
}

/** Bọc server action: trả lỗi nghiệp vụ dạng chuỗi để form hiển thị. */
export async function action(fn: () => Promise<unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e.message };
    if (e instanceof ZodError) return { ok: false, error: e.issues.map((i) => i.message).join("; ") };
    console.error(e);
    // Kèm nguyên nhân ngắn gọn (lỗi DB, thiếu cấu hình…) để dễ tìm lỗi thay vì câu chung chung
    const err = e as { message?: string; code?: string; cause?: { message?: string; code?: string } };
    const detail = [err.code ?? err.cause?.code, err.cause?.message ?? err.message].filter(Boolean).join(" ").slice(0, 300);
    return { ok: false, error: detail ? `Lỗi máy chủ: ${detail}` : "Lỗi máy chủ, thử lại sau" };
  }
}

export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

/** Địa chỉ public của app để dựng link gửi ra ngoài (Lark): APP_URL → cài đặt appUrl → header của request. */
export async function appBaseUrl(): Promise<string> {
  const fixed = process.env.APP_URL?.trim() || (await getSetting(getDb(), "appUrl"));
  if (fixed) return fixed.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

// Tiện ích phía máy chủ cho trang và route API.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getDb } from "./db";
import { HttpError, type SessionUser } from "./auth/access";
import { SESSION_COOKIE, readSessionToken, refreshUser } from "./auth/session";

export async function currentUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return refreshUser(getDb(), await readSessionToken(token));
}

/** Dùng trong trang: chưa đăng nhập thì chuyển về /login. */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser();
  if (!u) redirect("/login");
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
    return { ok: false, error: "Lỗi máy chủ, thử lại sau" };
  }
}

export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.get("authorization") === `Bearer ${secret}`;
}

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { HttpError } from "@/lib/auth/access";
import { SESSION_COOKIE, createSessionToken, sessionCookieOptions, verifyLogin } from "@/lib/auth/session";

const Body = z.object({ login: z.string().min(3), password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const { login, password } = Body.parse(await req.json());
    const user = await verifyLogin(getDb(), login, password);
    const res = NextResponse.json({ ok: true, role: user.role });
    res.cookies.set(SESSION_COOKIE, await createSessionToken(user), sessionCookieOptions);
    return res;
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 400;
    return NextResponse.json({ error: e instanceof HttpError ? e.message : "Nhập số điện thoại/email và mật khẩu" }, { status });
  }
}

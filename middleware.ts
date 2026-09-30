import { NextResponse, type NextRequest } from "next/server";

// Chặn sớm người chưa có cookie phiên; kiểm tra chữ ký và vai trò nằm ở máy chủ (lib/server.ts).
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/api/") || pathname.startsWith("/_next") || pathname === "/favicon.ico") {
    return NextResponse.next();
  }
  if (!req.cookies.get("loci_session")) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

import { NextResponse, type NextRequest } from "next/server";

// File cài app (PWA) phải tải được trước khi đăng nhập.
const PUBLIC_FILES = ["/favicon.ico", "/manifest.webmanifest", "/sw.js", "/offline.html"];

// Chặn sớm người chưa có cookie phiên; kiểm tra chữ ký và vai trò nằm ở máy chủ (lib/server.ts).
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith("/login") || pathname.startsWith("/api/") || pathname.startsWith("/_next") || pathname.startsWith("/icons/") || PUBLIC_FILES.includes(pathname)) {
    return NextResponse.next();
  }
  if (!req.cookies.get("loci_session")) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}

// GET /api/photo?path=bucket/… — trả ảnh từ bucket private sau khi kiểm tra quyền xem bản ghi chứa ảnh.
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { currentUser } from "@/lib/server";
import { canViewPhoto } from "@/lib/services/photos";
import { fetchPhoto } from "@/lib/storage";

export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "Chưa đăng nhập" }, { status: 401 });
  const path = new URL(req.url).searchParams.get("path") ?? "";
  // Không phân biệt "không có" và "không được xem" để khỏi lộ đường dẫn ảnh của người khác
  if (!(await canViewPhoto(getDb(), user, path))) return NextResponse.json({ error: "Không tìm thấy ảnh" }, { status: 404 });
  try {
    const res = await fetchPhoto(path);
    if (!res.ok || !res.body) return NextResponse.json({ error: "Không đọc được ảnh" }, { status: 502 });
    return new Response(res.body, {
      headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "private, max-age=3600" },
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Không đọc được ảnh" }, { status: 502 });
  }
}

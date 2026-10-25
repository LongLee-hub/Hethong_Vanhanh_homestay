// Lưu ảnh (hóa đơn, chuyển khoản, nghiệm thu) lên Supabase Storage.
// Ảnh đã được nén ở trình duyệt trước khi gửi (xem components/PhotoInput.tsx).
import { HttpError } from "./auth/access";

const BUCKET = process.env.SUPABASE_BUCKET ?? "loci-photos";

export async function uploadPhoto(file: File, folder: string): Promise<string> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY để lưu ảnh");
  if (file.size > 8 * 1024 * 1024) throw new HttpError(400, "Ảnh quá 8MB");
  const ext = (file.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
  const path = `${folder}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": file.type || "image/jpeg", "x-upsert": "false" },
    body: Buffer.from(await file.arrayBuffer()),
  });
  if (!res.ok) {
    // Báo rõ ra form thay vì "Lỗi máy chủ" chung chung (sai tên bucket, sai khóa…)
    console.error("Lưu ảnh lỗi", res.status, await res.text().catch(() => ""));
    throw new HttpError(502, `Không lưu được ảnh (lỗi ${res.status}), kiểm tra SUPABASE_BUCKET`);
  }
  // Bucket để private; trang hiển thị ảnh qua /api/photo?path=… có kiểm tra quyền (giai đoạn 5)
  return `${BUCKET}/${path}`;
}

/** Đọc ảnh đã lưu (dạng "bucket/đường-dẫn") từ bucket private bằng khóa máy chủ. Quyền xem kiểm tra ở lib/services/photos.ts. */
export async function fetchPhoto(stored: string): Promise<Response> {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) throw new Error("Chưa cấu hình SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY để đọc ảnh");
  return fetch(`${base}/storage/v1/object/authenticated/${stored}`, { headers: { Authorization: `Bearer ${key}` } });
}

/** Đường dẫn hiển thị ảnh trong app, đi qua route có kiểm tra quyền. */
export const photoHref = (stored: string) => `/api/photo?path=${encodeURIComponent(stored)}`;

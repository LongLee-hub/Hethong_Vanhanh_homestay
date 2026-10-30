"use server";
// Lấy đánh giá từ Dayladau ngay, không đợi lượt đồng bộ 06:00. Chỉ Admin.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/server";
import { can } from "@/lib/auth/access";
import { syncReviews } from "@/lib/dayladau/reviews";

type State = { ok: boolean; error?: string; info?: string } | null;

export async function syncReviewsAction(_: State, _f: FormData): Promise<State> {
  const user = await requireUser();
  if (!can(user, "admin")) return { ok: false, error: "Chỉ Admin được lấy đánh giá thủ công" };
  try {
    const r = await syncReviews(getDb());
    revalidatePath("/reviews");
    if (r.errors.length && !r.created && !r.updated) return { ok: false, error: r.errors[0].message };
    const parts = [`${r.created} đánh giá mới`, `${r.updated} đã cập nhật`];
    if (r.unmapped.length) parts.push(`${r.unmapped.reduce((s, u) => s + u.count, 0)} bỏ qua vì listing chưa gắn phòng`);
    if (r.errors.length) parts.push(`${r.errors.length} lỗi`);
    return { ok: true, info: `Đã lấy xong: ${parts.join(", ")}.` };
  } catch (e) {
    console.error(e);
    return { ok: false, error: "Không lấy được đánh giá, thử lại sau" };
  }
}

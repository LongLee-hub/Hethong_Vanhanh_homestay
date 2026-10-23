// Bộ lọc đơn đặt phòng, dùng chung cho trang và file Excel xuất ra.
import * as D from "@/lib/domain";
import type { DB } from "@/lib/db";
import type { SessionUser } from "@/lib/auth/access";
import { bookingsForMonth, bookingsInRange } from "@/lib/queries";
import { fold } from "@/lib/bank/statement-parser";

export interface BookingFilter {
  month: string;
  prop: string;
  q: string;
  from: string;
  to: string;
  /** Có khoảng ngày: xem qua nhiều tháng thay vì tháng đang chọn */
  ranged: boolean;
  filtered: boolean;
}

const isDay = (v?: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : "");

/** Đọc bộ lọc từ query string; cơ sở ngoài phạm vi được xem thì bỏ qua. */
export function parseBookingFilter(sp: Record<string, string | undefined>, month: string, propertyIds: string[]): BookingFilter {
  const prop = sp.prop && propertyIds.includes(sp.prop) ? sp.prop : "";
  const q = (sp.q ?? "").trim();
  const from = isDay(sp.from);
  const to = isDay(sp.to);
  const ranged = !!(from || to);
  return { month, prop, q, from, to, ranged, filtered: ranged || !!prop || !!q };
}

/** Query string giữ nguyên bộ lọc (dùng cho link xuất Excel). */
export function filterQuery(f: BookingFilter): string {
  const p = new URLSearchParams();
  if (!f.ranged) p.set("month", f.month);
  if (f.prop) p.set("prop", f.prop);
  if (f.q) p.set("q", f.q);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p.toString();
}

/** Mô tả khoảng thời gian, vd "Có đêm ở từ 01/10/2026 đến 15/10/2026". */
export function filterScope(f: BookingFilter): string {
  if (!f.ranged) return "Có đêm ở trong tháng";
  return `Có đêm ở ${f.from ? `từ ${D.formatDateVN(f.from)} ` : ""}${f.to ? `đến ${D.formatDateVN(f.to)}` : ""}`.trim();
}

/** Đơn có ít nhất một đêm ở trong khoảng (hoặc tháng), khớp cơ sở và tên khách / mã đơn. */
export async function filteredBookings(db: DB, user: SessionUser, f: BookingFilter) {
  const all = f.ranged ? await bookingsInRange(db, user, f.from || "2000-01-01", f.to || "2999-12-31") : await bookingsForMonth(db, user, f.month);
  const words = fold(f.q).split(" ").filter(Boolean);
  return all.filter((b) => (!f.prop || b.propertyId === f.prop) && words.every((w) => fold(`${b.guestName ?? ""} ${b.externalId ?? ""}`).includes(w)));
}

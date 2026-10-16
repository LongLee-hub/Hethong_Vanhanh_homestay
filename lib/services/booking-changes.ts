// Đơn đã cập nhật: đọc booking_change_logs (upsertBooking ghi mỗi lần đơn được tạo hoặc đổi), lọc theo cơ sở được phép.
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { bookingChangeLogs, bookings, users } from "../db/schema";
import { allowedPropertyIds, can, type SessionUser } from "../auth/access";

export type ChangeKind = "NEW" | "IMPORTED" | "CHANGED" | "CANCELLED" | "RESTORED";
type Snap = Record<string, string | number | null>;

/** Các trường theo dõi, theo thứ tự hiển thị. money = ẩn với người không xem được số tiền. */
export const CHANGE_FIELDS: { key: string; label: string; money?: boolean }[] = [
  { key: "checkIn", label: "Nhận phòng" },
  { key: "checkOut", label: "Trả phòng" },
  { key: "roomId", label: "Phòng" },
  { key: "status", label: "Trạng thái" },
  { key: "rentalType", label: "Loại thuê" },
  { key: "grossAmount", label: "Khách trả", money: true },
  { key: "commissionAmount", label: "Phí kênh bán", money: true },
  { key: "netAmount", label: "Thực nhận", money: true },
];

/** Số ngày tối đa giữa ngày khách đặt và lúc đơn vào hệ thống để còn tính là đơn mới. */
export const IMPORT_LAG_DAYS = 2;

/**
 * Đơn vào hệ thống lần đầu mà khách đã đặt từ lâu (lần nhập lịch sử, hoặc phòng mới gắn listing) là IMPORTED,
 * để không lẫn với đơn khách vừa đặt.
 */
export function changeKind(before: Snap | null, after: Snap, bookedAt?: string | null, changedOn?: string): ChangeKind {
  if (!before) return bookedAt && changedOn && bookedAt < D.addDays(changedOn, -IMPORT_LAG_DAYS) ? "IMPORTED" : "NEW";
  if (before.status !== after.status) return after.status === "CANCELLED" ? "CANCELLED" : "RESTORED";
  return "CHANGED";
}

export function changedFields(before: Snap | null, after: Snap, showMoney: boolean) {
  if (!before) return [];
  return CHANGE_FIELDS.filter((f) => (showMoney || !f.money) && f.key !== "status" && (before[f.key] ?? null) !== (after[f.key] ?? null))
    .map((f) => ({ ...f, before: before[f.key] ?? null, after: after[f.key] ?? null }));
}

export interface BookingChange {
  id: string;
  changedAt: Date;
  by: string; // "Đồng bộ Dayladau" hoặc tên người sửa
  reason: string | null;
  kind: ChangeKind;
  fields: ReturnType<typeof changedFields>;
  booking: { id: string; externalId: string | null; guestName: string | null; propertyId: string; roomId: string; channel: string; checkIn: string; checkOut: string; netAmount: number | null; source: "DAYLADAU" | "MANUAL" };
}

/** Thay đổi từ `since` trở đi, mới nhất trước. Thay đổi chỉ khác số tiền bị bỏ với người không xem được số tiền. */
export async function bookingChanges(db: DB, user: SessionUser, since: Date, limit = 5000): Promise<BookingChange[]> {
  const ids = await allowedPropertyIds(db, user);
  if (!ids.length) return [];
  const showMoney = can(user, "viewBookingAmounts");
  const rows = await db
    .select({
      id: bookingChangeLogs.id, changedAt: bookingChangeLogs.changedAt, changedBy: bookingChangeLogs.changedBy, reason: bookingChangeLogs.reason,
      before: bookingChangeLogs.before, after: bookingChangeLogs.after, userName: users.name,
      bId: bookings.id, externalId: bookings.externalId, bookedAt: bookings.bookedAt, guestName: bookings.guestName, propertyId: bookings.propertyId, roomId: bookings.roomId,
      channel: bookings.channel, checkIn: bookings.checkIn, checkOut: bookings.checkOut, netAmount: bookings.netAmount, source: bookings.source,
    })
    .from(bookingChangeLogs)
    .innerJoin(bookings, eq(bookings.id, bookingChangeLogs.bookingId))
    .leftJoin(users, eq(users.id, bookingChangeLogs.changedBy))
    .where(and(inArray(bookings.propertyId, ids), gte(bookingChangeLogs.changedAt, since)))
    .orderBy(desc(bookingChangeLogs.changedAt))
    .limit(limit);

  return rows.flatMap((r) => {
    const before = r.before as Snap | null, after = r.after as Snap;
    const kind = changeKind(before, after, r.bookedAt, D.todayVN(r.changedAt));
    // Đơn hủy / khôi phục: tiền về 0 hoặc trở lại là hệ quả, không cần liệt kê
    const fields = changedFields(before, after, showMoney && kind === "CHANGED");
    if (kind === "CHANGED" && !fields.length) return [];
    return [{
      id: r.id, changedAt: r.changedAt, reason: r.reason, kind, fields,
      by: r.changedBy === "SYNC" ? "Đồng bộ Dayladau" : r.userName ?? "Người dùng đã xóa",
      booking: {
        id: r.bId, externalId: r.externalId, guestName: r.guestName, propertyId: r.propertyId, roomId: r.roomId, channel: r.channel,
        checkIn: r.checkIn, checkOut: r.checkOut, netAmount: showMoney ? r.netAmount : null, source: r.source,
      },
    }];
  });
}

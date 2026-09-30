import { and, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { bookings } from "@/lib/db/schema";
import { allowedPropertyIds, can, requirePermission } from "@/lib/auth/access";
import { saveManualBooking } from "@/lib/services/bookings";
import { api } from "@/lib/server";

// GET /api/bookings?month=2026-09 — đơn có đêm trong tháng, trong phạm vi cơ sở được phép
export const GET = api(async ({ user, req }) => {
  requirePermission(user, "viewBookings");
  const month = new URL(req.url).searchParams.get("month") ?? D.monthOf(D.todayVN());
  const db = getDb();
  const pids = await allowedPropertyIds(db, user);
  if (!pids.length) return [];
  const rows = await db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.propertyId, pids), lte(bookings.checkIn, D.lastDay(month)), gt(bookings.checkOut, D.firstDay(month))));
  // Buồng phòng chỉ xem lịch check-in/out, không xem tiền
  if (!can(user, "viewBookingAmounts")) {
    return rows.map(({ id, propertyId, roomId, guestName, checkIn, checkOut, status, channel }) => ({ id, propertyId, roomId, guestName, checkIn, checkOut, status, channel }));
  }
  return rows.map(({ rawPayload, ...r }) => r);
});

const Manual = z.object({
  id: z.string().optional(),
  propertyId: z.string(),
  roomId: z.string(),
  guestName: z.string().min(1, "Nhập tên khách"),
  bookedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().int().nonnegative(),
  status: z.enum(["CONFIRMED", "CANCELLED"]).default("CONFIRMED"),
  transferProofUrl: z.string().min(1, "Bắt buộc có ảnh chuyển khoản"),
  reason: z.string().optional(),
});

// POST /api/bookings — tạo/sửa đơn ngoài OTA
export const POST = api(async ({ user, req }) => saveManualBooking(getDb(), user, Manual.parse(await req.json())));

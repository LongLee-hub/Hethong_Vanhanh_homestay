// Quản lý cơ sở: sửa thông tin, ngưng / mở lại hoạt động. Tạo cơ sở dùng createProperty trong lib/dayladau/admin.ts.
import { and, eq, gt } from "drizzle-orm";
import type { DB } from "../db";
import { bookings, properties } from "../db/schema";
import { badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";

export type PropertyRow = typeof properties.$inferSelect;

export interface UpdatePropertyInput {
  name: string;
  address: string | null;
  investmentAmount: number;
  investmentStartMonth: string | null;
  occupancyKpiPct: number;
  variableCostPerNight: number;
  fixedCostMonthly: number;
}

export async function updateProperty(db: DB, user: SessionUser, propertyId: string, input: UpdatePropertyInput): Promise<PropertyRow> {
  requirePermission(user, "admin");
  if (!input.name.trim()) throw badRequest("Nhập tên cơ sở");
  if (input.occupancyKpiPct < 0 || input.occupancyKpiPct > 100) throw badRequest("KPI kín phòng phải từ 0 đến 100%");
  if (input.investmentStartMonth && !/^\d{4}-\d{2}$/.test(input.investmentStartMonth)) throw badRequest("Tháng bắt đầu đầu tư không hợp lệ");
  const [row] = await db
    .update(properties)
    .set({ ...input, name: input.name.trim(), address: input.address?.trim() || null })
    .where(eq(properties.id, propertyId))
    .returning();
  if (!row) throw notFound("Không tìm thấy cơ sở");
  return row;
}

/** Ngưng hoạt động: không cho khi cơ sở còn đơn đặt chưa trả phòng, để doanh thu không bị treo. */
export async function setPropertyActive(db: DB, user: SessionUser, propertyId: string, active: boolean, today: string): Promise<PropertyRow> {
  requirePermission(user, "admin");
  if (!active) {
    const open = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.propertyId, propertyId), eq(bookings.status, "CONFIRMED"), gt(bookings.checkOut, today)))
      .limit(1);
    if (open.length) throw badRequest("Cơ sở còn đơn đặt chưa trả phòng, chưa thể ngưng hoạt động");
  }
  const [row] = await db.update(properties).set({ active }).where(eq(properties.id, propertyId)).returning();
  if (!row) throw notFound("Không tìm thấy cơ sở");
  return row;
}

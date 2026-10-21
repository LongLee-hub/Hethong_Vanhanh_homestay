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
  /** Mã viết tắt trong nội dung chuyển khoản, vd ["vp"]. Không truyền = giữ nguyên. */
  bankCodes?: string[];
}

/** Chuẩn hóa mã: chữ thường không dấu, bỏ trùng. */
export function normalizeBankCodes(raw: string[] | string): string[] {
  const list = Array.isArray(raw) ? raw : raw.split(/[,;\s]+/);
  const out = list.map((c) => c.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
  return [...new Set(out)];
}

export async function updateProperty(db: DB, user: SessionUser, propertyId: string, input: UpdatePropertyInput): Promise<PropertyRow> {
  requirePermission(user, "admin");
  if (!input.name.trim()) throw badRequest("Nhập tên cơ sở");
  if (input.occupancyKpiPct < 0 || input.occupancyKpiPct > 100) throw badRequest("KPI kín phòng phải từ 0 đến 100%");
  if (input.investmentStartMonth && !/^\d{4}-\d{2}$/.test(input.investmentStartMonth)) throw badRequest("Tháng bắt đầu đầu tư không hợp lệ");
  const { bankCodes, ...rest } = input;
  const codes = bankCodes === undefined ? undefined : normalizeBankCodes(bankCodes);
  if (codes?.some((c) => c.length < 2)) throw badRequest("Mã cơ sở trên sao kê phải từ 2 ký tự");
  if (codes?.includes("coso")) throw badRequest('"coso" dành cho chi phí chung, chọn mã khác');
  if (codes?.length) {
    const others = await db.select({ id: properties.id, name: properties.name, codes: properties.bankCodes }).from(properties);
    const clash = others.find((o) => o.id !== propertyId && o.codes.some((c) => codes.includes(c)));
    if (clash) throw badRequest(`Mã ${clash.codes.filter((c) => codes.includes(c)).join(", ")} đã dùng cho ${clash.name}`);
  }
  const [row] = await db
    .update(properties)
    .set({ ...rest, ...(codes ? { bankCodes: codes } : {}), name: input.name.trim(), address: input.address?.trim() || null })
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

// Chỉ tiêu tháng (KPI) theo cơ sở. Admin nhập; NĐT xem chỉ tiêu cơ sở mình. Chỉ tiêu của NĐT tự cộng từ các cơ sở.
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { properties, propertyTargets } from "../db/schema";
import { allowedPropertyIds, badRequest, requirePermission, type SessionUser } from "../auth/access";
import * as D from "../domain";
import { isPropertyMonthLocked } from "./settlement";

export type TargetMap = Record<string, D.KpiTarget>;

/** Chỉ tiêu của tháng cho các cơ sở người dùng được xem. Cơ sở chưa nhập thì không có trong map. */
export async function targetsForMonth(db: DB, user: SessionUser, month: string, propertyIds?: string[]): Promise<TargetMap> {
  const allowed = await allowedPropertyIds(db, user);
  const ids = propertyIds ? propertyIds.filter((id) => allowed.includes(id)) : allowed;
  if (!ids.length) return {};
  const rows = await db
    .select()
    .from(propertyTargets)
    .where(and(eq(propertyTargets.month, month), inArray(propertyTargets.propertyId, ids)));
  return Object.fromEntries(rows.map((r) => [r.propertyId, { revenue: r.revenue, occupancyPct: r.occupancyPct, adr: r.adr }]));
}

export interface TargetInput {
  propertyId: string;
  revenue: number;
  occupancyPct: number;
  adr: number;
}

function validate(t: TargetInput) {
  if (!Number.isFinite(t.revenue) || t.revenue < 0) throw badRequest("Doanh thu mục tiêu không hợp lệ");
  if (!Number.isFinite(t.occupancyPct) || t.occupancyPct < 0 || t.occupancyPct > 100) throw badRequest("Công suất mục tiêu phải từ 0 đến 100%");
  if (!Number.isFinite(t.adr) || t.adr < 0) throw badRequest("Giá trung bình mục tiêu không hợp lệ");
}

/**
 * Lưu chỉ tiêu tháng cho nhiều cơ sở cùng lúc. Chỉ Admin.
 * Cơ sở đã khóa sổ tháng đó thì bỏ qua (giữ kết quả KPI cũ không đổi) và trả về tên để báo lại.
 * Dòng để trống cả ba ô thì xóa chỉ tiêu của cơ sở đó.
 */
export async function saveTargets(db: DB, user: SessionUser, month: string, inputs: TargetInput[]): Promise<{ saved: number; skippedLocked: string[] }> {
  requirePermission(user, "admin");
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("Tháng không hợp lệ");
  inputs.forEach(validate);
  const ids = inputs.map((i) => i.propertyId);
  const names = ids.length
    ? Object.fromEntries((await db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ids))).map((p) => [p.id, p.name]))
    : {};
  const skippedLocked: string[] = [];
  let saved = 0;
  for (const t of inputs) {
    if (!names[t.propertyId]) throw badRequest("Không tìm thấy cơ sở");
    if (await isPropertyMonthLocked(db, t.propertyId, month)) {
      skippedLocked.push(names[t.propertyId]);
      continue;
    }
    const where = and(eq(propertyTargets.propertyId, t.propertyId), eq(propertyTargets.month, month));
    if (!t.revenue && !t.occupancyPct && !t.adr) {
      await db.delete(propertyTargets).where(where);
      continue;
    }
    await db
      .insert(propertyTargets)
      .values({ propertyId: t.propertyId, month, revenue: Math.round(t.revenue), occupancyPct: t.occupancyPct, adr: Math.round(t.adr), updatedBy: user.id })
      .onConflictDoUpdate({
        target: [propertyTargets.propertyId, propertyTargets.month],
        set: { revenue: Math.round(t.revenue), occupancyPct: t.occupancyPct, adr: Math.round(t.adr), updatedBy: user.id, updatedAt: new Date() },
      });
    saved++;
  }
  return { saved, skippedLocked };
}

/** Chỉ tiêu tháng trước của các cơ sở, để điền sẵn khi bấm "Chép từ tháng trước". Không ghi DB. */
export async function previousMonthTargets(db: DB, user: SessionUser, month: string): Promise<TargetMap> {
  requirePermission(user, "admin");
  return targetsForMonth(db, user, D.prevMonth(month));
}

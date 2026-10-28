// Tính cảnh báo sau mỗi lần đồng bộ (Đặc tả 8.2). Cảnh báo đang mở không tạo trùng; tự đóng khi hết điều kiện.
import { and, eq, gte, inArray, isNull, lt, lte, notInArray } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { alerts, bookingNights, properties, rooms, tasks } from "../db/schema";
import { notifyLark } from "./settings";

export async function computeAlerts(db: DB, today = D.todayVN()) {
  const month = D.monthOf(today);
  const active = new Set<string>();
  const fresh: string[] = [];

  const open = async (type: string, key: string, message: string, propertyId?: string) => {
    active.add(key);
    const [ex] = await db.select().from(alerts).where(eq(alerts.key, key)).limit(1);
    if (!ex) {
      await db.insert(alerts).values({ type, key, message, propertyId: propertyId ?? null, month });
      fresh.push(message);
    } else if (ex.resolvedAt) {
      await db.update(alerts).set({ resolvedAt: null, message }).where(eq(alerts.id, ex.id));
      fresh.push(message);
    }
  };

  // LOW_OCCUPANCY: công suất tháng hiện tại, tính cả đêm tương lai đã đặt
  const props = await db.select().from(properties).where(eq(properties.active, true));
  const allRooms = await db.select().from(rooms);
  for (const p of props) {
    const pr = allRooms.filter((r) => r.propertyId === p.id).map((r) => ({ id: r.id, propertyId: r.propertyId, openedOn: r.openedOn, closedOn: r.closedOn }));
    // Chỉ đọc đêm của tháng đang xét (trước đây đọc toàn bộ lịch sử của cơ sở)
    const nights = await db
      .select()
      .from(bookingNights)
      .where(and(eq(bookingNights.propertyId, p.id), gte(bookingNights.nightDate, D.firstDay(month)), lte(bookingNights.nightDate, D.lastDay(month))));
    const k = D.computeKpis(nights, pr, D.firstDay(month), D.lastDay(month));
    if (k.availableNights && k.occupancyPct < p.occupancyKpiPct) {
      await open("LOW_OCCUPANCY", `LOW_OCCUPANCY:${p.id}:${month}`, `${p.name}: công suất ${D.formatMonthVN(month).toLowerCase()} ${k.occupancyPct}% (gồm đêm đã đặt), dưới mức ${p.occupancyKpiPct}%`, p.id);
    }
  }

  // TASK_OVERDUE
  const overdue = await db.select().from(tasks).where(and(inArray(tasks.status, ["TODO", "IN_PROGRESS"]), lt(tasks.dueAt, new Date())));
  for (const t of overdue) await open("TASK_OVERDUE", `TASK_OVERDUE:${t.id}`, `Việc quá hạn: ${t.title}`, t.propertyId);

  // Tự đóng các cảnh báo LOW_OCCUPANCY / TASK_OVERDUE không còn đúng
  const managed = ["LOW_OCCUPANCY", "TASK_OVERDUE"];
  await db
    .update(alerts)
    .set({ resolvedAt: new Date() })
    .where(and(inArray(alerts.type, managed), isNull(alerts.resolvedAt), active.size ? notInArray(alerts.key, [...active]) : undefined));

  if (fresh.length) await notifyLark(db, `LOCI – cảnh báo mới:\n• ${fresh.join("\n• ")}`);
  return { opened: fresh.length, active: active.size };
}

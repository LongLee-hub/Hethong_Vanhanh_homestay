// Truy vấn đọc cho trang, luôn lọc theo cơ sở được phép.
import { and, asc, eq, gte, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import * as D from "./domain";
import type { DB } from "./db";
import { alerts, bookingNights, bookings, expenseCategories, expenses, investors, properties, rooms, users, userPropertyAccess } from "./db/schema";
import { allowedInvestorIds, allowedPropertyIds, assertPropertyAccess, type SessionUser } from "./auth/access";

export async function visibleProperties(db: DB, user: SessionUser) {
  const ids = await allowedPropertyIds(db, user);
  if (!ids.length) return [];
  const [props, rs] = await Promise.all([
    db.select().from(properties).where(inArray(properties.id, ids)).orderBy(asc(properties.name)),
    db.select().from(rooms).where(inArray(rooms.propertyId, ids)).orderBy(asc(rooms.name)),
  ]);
  return props.map((p) => ({ ...p, rooms: rs.filter((r) => r.propertyId === p.id) }));
}

export async function visibleInvestors(db: DB, user: SessionUser) {
  const ids = await allowedInvestorIds(db, user);
  return ids.length ? db.select({ id: investors.id, name: investors.name }).from(investors).where(inArray(investors.id, ids)).orderBy(asc(investors.name)) : [];
}

export const bookingsForMonth = (db: DB, user: SessionUser, month: string) => bookingsInRange(db, user, D.firstDay(month), D.lastDay(month));

/** Đơn có đêm ở trong khoảng (từ – đến, YYYY-MM-DD, tính cả hai đầu). Dùng cho bộ lọc thời gian. */
export async function bookingsInRange(db: DB, user: SessionUser, from: string, to: string) {
  const ids = await allowedPropertyIds(db, user);
  if (!ids.length) return [];
  return db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.propertyId, ids), lte(bookings.checkIn, to), gt(bookings.checkOut, from)))
    .orderBy(asc(bookings.checkIn));
}

export async function expensesForMonth(db: DB, user: SessionUser, month: string) {
  const ids = await allowedPropertyIds(db, user);
  const direct = ids.length ? await db.select().from(expenses).where(and(eq(expenses.month, month), inArray(expenses.propertyId, ids))).orderBy(asc(expenses.incurredOn)) : [];
  const common = await db.select().from(expenses).where(and(eq(expenses.month, month), isNull(expenses.propertyId)));
  return { direct, common };
}

/** Chi phí theo ngày phát sinh (từ – đến, YYYY-MM-DD), cả chi phí cơ sở được xem lẫn chi phí chung. Dùng cho bộ lọc thời gian. */
export async function expensesInRange(db: DB, user: SessionUser, from: string, to: string) {
  const ids = await allowedPropertyIds(db, user);
  const range = and(gte(expenses.incurredOn, from), lte(expenses.incurredOn, to));
  const direct = ids.length ? await db.select().from(expenses).where(and(range, inArray(expenses.propertyId, ids))).orderBy(asc(expenses.incurredOn)) : [];
  const common = await db.select().from(expenses).where(and(range, isNull(expenses.propertyId))).orderBy(asc(expenses.incurredOn));
  return { direct, common };
}

/** Id NĐT chịu chi phí chung (Unix); rỗng = chưa bật cho ai, chi phí chung chia cho mọi cơ sở. */
export async function commonCostInvestorIds(db: DB): Promise<string[]> {
  return (await db.select({ id: investors.id }).from(investors).where(eq(investors.sharesCommonCost, true))).map((r) => r.id);
}

export const categories = (db: DB) => db.select().from(expenseCategories).where(eq(expenseCategories.active, true)).orderBy(asc(expenseCategories.name));

export async function openAlerts(db: DB, user: SessionUser) {
  const ids = await allowedPropertyIds(db, user);
  const rows = await db.select().from(alerts).where(isNull(alerts.resolvedAt));
  return rows.filter((a) => (a.propertyId ? ids.includes(a.propertyId) : user.role === "ADMIN"));
}

export async function staffForProperties(db: DB, propertyIds: string[]) {
  if (!propertyIds.length) return [];
  return db
    .selectDistinct({ id: users.id, name: users.name, role: users.role, propertyId: userPropertyAccess.propertyId })
    .from(users)
    .innerJoin(userPropertyAccess, eq(userPropertyAccess.userId, users.id))
    .where(and(eq(users.active, true), inArray(userPropertyAccess.propertyId, propertyIds)));
}

export function monthParam(v: string | string[] | undefined): string {
  const s = Array.isArray(v) ? v[0] : v;
  return s && /^\d{4}-\d{2}$/.test(s) ? s : D.monthOf(D.todayVN());
}

// ---------- Tổng hợp doanh thu ----------

export interface RoomDailyRevenue {
  roomId: string;
  roomName: string;
  nightDate: string;
  netAmount: number;
  bookingCount: number;
}

/** Doanh thu từng phòng theo từng ngày trong 1 tháng (cho 1 cơ sở). */
export async function roomRevenueByDay(db: DB, user: SessionUser, propertyId: string, month: string): Promise<RoomDailyRevenue[]> {
  await assertPropertyAccess(db, user, propertyId);
  const from = D.firstDay(month);
  const to = D.lastDay(month);
  const rows = await db
    .select({
      roomId: bookingNights.roomId,
      roomName: rooms.name,
      nightDate: bookingNights.nightDate,
      netAmount: sql<number>`COALESCE(SUM(${bookingNights.netAmount}), 0)::int`,
      bookingCount: sql<number>`COUNT(DISTINCT ${bookingNights.bookingId})::int`,
    })
    .from(bookingNights)
    .innerJoin(rooms, eq(rooms.id, bookingNights.roomId))
    .where(and(eq(bookingNights.propertyId, propertyId), gte(bookingNights.nightDate, from), lte(bookingNights.nightDate, to)))
    .groupBy(bookingNights.roomId, rooms.name, bookingNights.nightDate)
    .orderBy(asc(rooms.name), asc(bookingNights.nightDate));
  return rows;
}

export interface PropertyMonthlyRevenue {
  propertyId: string;
  propertyName: string;
  totalNights: number;
  totalRevenue: number;
  roomCount: number;
}

/** Doanh thu từng cơ sở trong 1 tháng (tất cả cơ sở user được phép). */
export async function propertyRevenueByMonth(db: DB, user: SessionUser, month: string): Promise<PropertyMonthlyRevenue[]> {
  const pids = await allowedPropertyIds(db, user);
  if (!pids.length) return [];
  const from = D.firstDay(month);
  const to = D.lastDay(month);

  const revenueRows = await db
    .select({
      propertyId: bookingNights.propertyId,
      totalNights: sql<number>`COUNT(*)::int`,
      totalRevenue: sql<number>`COALESCE(SUM(${bookingNights.netAmount}), 0)::int`,
    })
    .from(bookingNights)
    .where(and(inArray(bookingNights.propertyId, pids), gte(bookingNights.nightDate, from), lte(bookingNights.nightDate, to)))
    .groupBy(bookingNights.propertyId);

  // Lấy thông tin cơ sở + đếm phòng active
  const props = await db.select().from(properties).where(inArray(properties.id, pids));
  const activeRooms = await db
    .select({
      propertyId: rooms.propertyId,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(rooms)
    .where(and(inArray(rooms.propertyId, pids), lte(rooms.openedOn, to)))
    .groupBy(rooms.propertyId);

  const revenueMap = new Map(revenueRows.map((r) => [r.propertyId, r]));
  const roomCountMap = new Map(activeRooms.map((r) => [r.propertyId, r.count]));

  return props.map((p) => ({
    propertyId: p.id,
    propertyName: p.name,
    totalNights: revenueMap.get(p.id)?.totalNights ?? 0,
    totalRevenue: revenueMap.get(p.id)?.totalRevenue ?? 0,
    roomCount: roomCountMap.get(p.id) ?? 0,
  }));
}

export interface InvestorMonthlyRevenue {
  investorId: string;
  investorName: string;
  propertyCount: number;
  totalRooms: number;
  totalNights: number;
  totalRevenue: number;
}

/** Doanh thu từng chủ đầu tư trong 1 tháng. */
export async function investorRevenueByMonth(db: DB, user: SessionUser, month: string): Promise<InvestorMonthlyRevenue[]> {
  const invIds = await allowedInvestorIds(db, user);
  if (!invIds.length) return [];
  const from = D.firstDay(month);
  const to = D.lastDay(month);

  // Lấy danh sách NĐT
  const invs = await db.select({ id: investors.id, name: investors.name }).from(investors).where(inArray(investors.id, invIds));

  // Lấy cơ sở theo NĐT
  const props = await db.select().from(properties).where(inArray(properties.investorId, invIds));
  const pids = props.map((p) => p.id);

  // Doanh thu theo cơ sở
  const revenueRows = pids.length
    ? await db
        .select({
          propertyId: bookingNights.propertyId,
          totalNights: sql<number>`COUNT(*)::int`,
          totalRevenue: sql<number>`COALESCE(SUM(${bookingNights.netAmount}), 0)::int`,
        })
        .from(bookingNights)
        .where(and(inArray(bookingNights.propertyId, pids), gte(bookingNights.nightDate, from), lte(bookingNights.nightDate, to)))
        .groupBy(bookingNights.propertyId)
    : [];

  // Phòng active theo cơ sở
  const activeRooms = pids.length
    ? await db
        .select({
          propertyId: rooms.propertyId,
          count: sql<number>`COUNT(*)::int`,
        })
        .from(rooms)
        .where(and(inArray(rooms.propertyId, pids), lte(rooms.openedOn, to)))
        .groupBy(rooms.propertyId)
    : [];

  const revenueMap = new Map(revenueRows.map((r) => [r.propertyId, r]));
  const roomCountMap = new Map(activeRooms.map((r) => [r.propertyId, r.count]));

  return invs.map((inv) => {
    const invProps = props.filter((p) => p.investorId === inv.id);
    return {
      investorId: inv.id,
      investorName: inv.name,
      propertyCount: invProps.length,
      totalRooms: invProps.reduce((s, p) => s + (roomCountMap.get(p.id) ?? 0), 0),
      totalNights: invProps.reduce((s, p) => s + (revenueMap.get(p.id)?.totalNights ?? 0), 0),
      totalRevenue: invProps.reduce((s, p) => s + (revenueMap.get(p.id)?.totalRevenue ?? 0), 0),
    };
  });
}


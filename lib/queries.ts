// Truy vấn đọc cho trang, luôn lọc theo cơ sở được phép.
import { and, asc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import * as D from "./domain";
import type { DB } from "./db";
import { alerts, bookings, expenseCategories, expenses, investors, properties, rooms, users, userPropertyAccess } from "./db/schema";
import { allowedInvestorIds, allowedPropertyIds, type SessionUser } from "./auth/access";

export async function visibleProperties(db: DB, user: SessionUser) {
  const ids = await allowedPropertyIds(db, user);
  if (!ids.length) return [];
  const props = await db.select().from(properties).where(inArray(properties.id, ids)).orderBy(asc(properties.name));
  const rs = await db.select().from(rooms).where(inArray(rooms.propertyId, ids)).orderBy(asc(rooms.name));
  return props.map((p) => ({ ...p, rooms: rs.filter((r) => r.propertyId === p.id) }));
}

export async function visibleInvestors(db: DB, user: SessionUser) {
  const ids = await allowedInvestorIds(db, user);
  return ids.length ? db.select({ id: investors.id, name: investors.name }).from(investors).where(inArray(investors.id, ids)).orderBy(asc(investors.name)) : [];
}

export async function bookingsForMonth(db: DB, user: SessionUser, month: string) {
  const ids = await allowedPropertyIds(db, user);
  if (!ids.length) return [];
  return db
    .select()
    .from(bookings)
    .where(and(inArray(bookings.propertyId, ids), lte(bookings.checkIn, D.lastDay(month)), gt(bookings.checkOut, D.firstDay(month))))
    .orderBy(asc(bookings.checkIn));
}

export async function expensesForMonth(db: DB, user: SessionUser, month: string) {
  const ids = await allowedPropertyIds(db, user);
  const direct = ids.length ? await db.select().from(expenses).where(and(eq(expenses.month, month), inArray(expenses.propertyId, ids))).orderBy(asc(expenses.incurredOn)) : [];
  const common = await db.select().from(expenses).where(and(eq(expenses.month, month), isNull(expenses.propertyId)));
  return { direct, common };
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

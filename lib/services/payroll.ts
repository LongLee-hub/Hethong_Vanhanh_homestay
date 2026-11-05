// Lương buồng phòng theo tháng.
// Công ca sáng / ca tối: lương tháng của ca ÷ công chuẩn (số ngày trong tháng − ngày nghỉ) × số ca đã vào.
// Tăng ca: đơn giá × số lần. Đánh giá tính theo tháng khách trả phòng, ở các cơ sở nhân viên được giao:
// thưởng mỗi đánh giá 5★, phạt mỗi đánh giá dưới 4★ (thang Dayladau 1–5).
import { and, asc, eq, gte, inArray, lte, or } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { attendance, housekeeperPay, payrollAdjustments, properties, reviews, userPropertyAccess, users } from "../db/schema";
import { badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { getAllSettings, setSetting } from "./settings";

export type Shift = "MORNING" | "EVENING" | "OVERTIME";
export const SHIFT_LABEL: Record<Shift, string> = { MORNING: "Ca sáng", EVENING: "Ca tối", OVERTIME: "Tăng ca" };

export interface PayrollRates {
  daysOff: number;
  overtimeRate: number;
  fiveStarBonus: number;
  lowReviewPenalty: number;
}

export const LOW_PENALTY_BELOW = 4;

export async function payrollRates(db: DB): Promise<PayrollRates> {
  const s = await getAllSettings(db);
  const n = (k: string, d: number) => (Number.isFinite(Number(s[k])) && s[k] !== "" ? Number(s[k]) : d);
  return {
    daysOff: n("payroll.daysOff", 2),
    overtimeRate: n("payroll.overtimeRate", 31000),
    fiveStarBonus: n("payroll.fiveStarBonus", 10000),
    lowReviewPenalty: n("payroll.lowReviewPenalty", 50000),
  };
}

export async function savePayrollRates(db: DB, user: SessionUser, r: PayrollRates) {
  requirePermission(user, "admin");
  for (const v of Object.values(r)) {
    if (!Number.isFinite(v) || v < 0) throw badRequest("Số tiền và số ngày nghỉ phải là số không âm");
  }
  if (r.daysOff >= 28) throw badRequest("Số ngày nghỉ phải nhỏ hơn 28");
  await Promise.all(Object.entries(r).map(([k, v]) => setSetting(db, `payroll.${k}`, String(Math.round(v)))));
}

/** Công chuẩn của tháng: số ngày trong tháng − ngày nghỉ. */
export const standardDays = (month: string, daysOff: number) => Math.max(1, D.daysInMonth(month) - daysOff);

export interface PayInput {
  morningMonthly: number;
  eveningMonthly: number;
  morningShifts: number;
  eveningShifts: number;
  overtime: number;
  fiveStar: number;
  low: number;
  adjustments: number;
}

export interface PayLine extends PayInput {
  standardDays: number;
  morningRate: number;
  eveningRate: number;
  morningPay: number;
  eveningPay: number;
  overtimePay: number;
  bonus: number;
  penalty: number;
  total: number;
}

/** Tính lương một người (thuần, để test). Đơn giá 1 công làm tròn tới đồng. */
export function calcPay(month: string, rates: PayrollRates, p: PayInput): PayLine {
  const std = standardDays(month, rates.daysOff);
  const morningRate = Math.round(p.morningMonthly / std);
  const eveningRate = Math.round(p.eveningMonthly / std);
  const morningPay = morningRate * p.morningShifts;
  const eveningPay = eveningRate * p.eveningShifts;
  const overtimePay = rates.overtimeRate * p.overtime;
  const bonus = rates.fiveStarBonus * p.fiveStar;
  const penalty = rates.lowReviewPenalty * p.low;
  return {
    ...p, standardDays: std, morningRate, eveningRate, morningPay, eveningPay, overtimePay, bonus, penalty,
    total: morningPay + eveningPay + overtimePay + bonus - penalty + p.adjustments,
  };
}

export interface PayrollRow extends PayLine {
  userId: string;
  name: string;
  phone: string | null;
  active: boolean;
  propertyNames: string[];
  adjustmentItems: { id: string; amount: number; reason: string }[];
}

/** Bảng lương tháng của mọi nhân viên buồng phòng (đang hoạt động, hoặc đã nghỉ nhưng có công trong tháng). Chỉ admin. */
export async function monthlyPayroll(db: DB, user: SessionUser, month: string) {
  requirePermission(user, "admin");
  const from = D.firstDay(month);
  const to = D.lastDay(month);
  const rates = await payrollRates(db);

  const att = await db
    .select({ userId: attendance.userId, shift: attendance.shift })
    .from(attendance)
    .innerJoin(users, eq(users.id, attendance.userId))
    .where(and(eq(users.role, "HOUSEKEEPER"), gte(attendance.date, from), lte(attendance.date, to)));
  const workedIds = [...new Set(att.map((a) => a.userId))];
  const staff = await db
    .select({ id: users.id, name: users.name, phone: users.phone, active: users.active })
    .from(users)
    .where(and(eq(users.role, "HOUSEKEEPER"), workedIds.length ? or(eq(users.active, true), inArray(users.id, workedIds)) : eq(users.active, true)))
    .orderBy(asc(users.name));
  if (!staff.length) return { month, rates, standardDays: standardDays(month, rates.daysOff), rows: [] as PayrollRow[] };
  const ids = staff.map((u) => u.id);

  const [pay, access, adj, props] = await Promise.all([
    db.select().from(housekeeperPay).where(inArray(housekeeperPay.userId, ids)),
    db.select().from(userPropertyAccess).where(inArray(userPropertyAccess.userId, ids)),
    db.select().from(payrollAdjustments).where(and(eq(payrollAdjustments.month, month), inArray(payrollAdjustments.userId, ids))).orderBy(asc(payrollAdjustments.createdAt)),
    db.select({ id: properties.id, name: properties.name }).from(properties),
  ]);
  const propIds = [...new Set(access.map((a) => a.propertyId))];
  const rv = propIds.length
    ? await db.select({ propertyId: reviews.propertyId, score: reviews.score }).from(reviews)
        .where(and(inArray(reviews.propertyId, propIds), gte(reviews.reviewDate, from), lte(reviews.reviewDate, to)))
    : [];
  const propName = new Map(props.map((p) => [p.id, p.name]));

  const rows: PayrollRow[] = staff.map((u) => {
    const mine = att.filter((a) => a.userId === u.id);
    const myProps = access.filter((a) => a.userId === u.id).map((a) => a.propertyId);
    const myReviews = rv.filter((r) => myProps.includes(r.propertyId)).map((r) => Number(r.score)).filter((v) => v > 0);
    const p = pay.find((x) => x.userId === u.id);
    const items = adj.filter((a) => a.userId === u.id);
    const line = calcPay(month, rates, {
      morningMonthly: p?.morningMonthly ?? 0,
      eveningMonthly: p?.eveningMonthly ?? 0,
      morningShifts: mine.filter((a) => a.shift === "MORNING").length,
      eveningShifts: mine.filter((a) => a.shift === "EVENING").length,
      overtime: mine.filter((a) => a.shift === "OVERTIME").length,
      fiveStar: myReviews.filter((v) => v >= 5).length,
      low: myReviews.filter((v) => v < LOW_PENALTY_BELOW).length,
      adjustments: items.reduce((s, a) => s + a.amount, 0),
    });
    return {
      ...line, userId: u.id, name: u.name, phone: u.phone, active: u.active,
      propertyNames: myProps.map((id) => propName.get(id) ?? "").filter(Boolean).sort(),
      adjustmentItems: items.map((a) => ({ id: a.id, amount: a.amount, reason: a.reason })),
    };
  });
  return { month, rates, standardDays: standardDays(month, rates.daysOff), rows };
}

export async function setHousekeeperPay(db: DB, user: SessionUser, userId: string, morningMonthly: number, eveningMonthly: number) {
  requirePermission(user, "admin");
  if (![morningMonthly, eveningMonthly].every((v) => Number.isFinite(v) && v >= 0)) throw badRequest("Lương phải là số không âm");
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.role !== "HOUSEKEEPER") throw notFound("Không tìm thấy nhân viên buồng phòng");
  const v = { morningMonthly: Math.round(morningMonthly), eveningMonthly: Math.round(eveningMonthly), updatedBy: user.id, updatedAt: new Date() };
  await db.insert(housekeeperPay).values({ userId, ...v }).onConflictDoUpdate({ target: housekeeperPay.userId, set: v });
}

export async function addPayrollAdjustment(db: DB, user: SessionUser, userId: string, month: string, amount: number, reason: string) {
  requirePermission(user, "admin");
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("Tháng không hợp lệ");
  if (!Number.isFinite(amount) || amount === 0) throw badRequest("Nhập số tiền khác 0 (số âm để trừ)");
  if (!reason.trim()) throw badRequest("Nhập lý do cộng/trừ");
  await db.insert(payrollAdjustments).values({ userId, month, amount: Math.round(amount), reason: reason.trim(), createdBy: user.id });
}

export async function deletePayrollAdjustment(db: DB, user: SessionUser, id: string) {
  requirePermission(user, "admin");
  await db.delete(payrollAdjustments).where(eq(payrollAdjustments.id, id));
}

// Quyết toán, khóa sổ, hoàn vốn, dự kiến (Đặc tả 5.3–5.8). Đọc DB rồi gọi hàm thuần trong lib/domain.
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import {
  adjustments, bookingNights, expenses, investors, monthPeriods, properties, rooms, settlementLines, settlementUnlockLogs, settlements,
} from "../db/schema";
import { assertInvestorAccess, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { feePct } from "./settings";

export async function isCommonFinalized(db: DB, month: string): Promise<boolean> {
  const [p] = await db.select().from(monthPeriods).where(eq(monthPeriods.month, month)).limit(1);
  return !!p?.commonCostsFinalized;
}

async function allRooms(db: DB): Promise<D.RoomLite[]> {
  return (await db.select().from(rooms)).map((r) => ({ id: r.id, propertyId: r.propertyId, openedOn: r.openedOn, closedOn: r.closedOn }));
}

async function nightsBetween(db: DB, propertyIds: string[], from: string, to: string): Promise<D.NightLite[]> {
  if (!propertyIds.length) return [];
  const rows = await db
    .select()
    .from(bookingNights)
    .where(and(inArray(bookingNights.propertyId, propertyIds), gte(bookingNights.nightDate, from), lte(bookingNights.nightDate, to)));
  return rows.map((n) => ({ bookingId: n.bookingId, propertyId: n.propertyId, roomId: n.roomId, nightDate: n.nightDate, netAmount: n.netAmount }));
}

async function expensesFor(db: DB, months: string[], propertyIds: string[]): Promise<D.ExpenseLite[]> {
  const rows = await db
    .select({ propertyId: expenses.propertyId, month: expenses.month, amount: expenses.amount })
    .from(expenses)
    .where(and(inArray(expenses.month, months), or(isNull(expenses.propertyId), propertyIds.length ? inArray(expenses.propertyId, propertyIds) : undefined)));
  return rows;
}

/** Tính quyết toán từ dữ liệu hiện tại (không đọc bản đã khóa). */
export async function computeSettlement(db: DB, investorId: string, month: string): Promise<D.InvestorSettlement> {
  const pids = (await db.select({ id: properties.id }).from(properties).where(eq(properties.investorId, investorId))).map((r) => r.id);
  const [roomsAll, nights, exps, adjs, finalized, pct] = await Promise.all([
    allRooms(db),
    nightsBetween(db, pids, D.firstDay(month), D.lastDay(month)),
    expensesFor(db, [month, D.prevMonth(month)], pids),
    pids.length ? db.select().from(adjustments).where(and(inArray(adjustments.propertyId, pids), eq(adjustments.appliedMonth, month))) : Promise.resolve([]),
    isCommonFinalized(db, month),
    feePct(db),
  ]);
  return D.settleInvestorMonth({
    month, propertyIds: pids, rooms: roomsAll, nights, expenses: exps,
    adjustments: adjs.map((a) => ({ propertyId: a.propertyId, appliedMonth: a.appliedMonth, amount: a.amount })),
    commonFinalized: finalized, feePct: pct,
  });
}

export type SettlementView = D.InvestorSettlement & { investorId: string; status: "DRAFT" | "LOCKED" | "OPEN"; lockedAt?: Date | null };

/** Quyết toán để hiển thị: tháng đã khóa đọc từ bảng lưu, không tính lại (5.5). */
export async function getSettlement(db: DB, user: SessionUser, investorId: string, month: string): Promise<SettlementView> {
  await assertInvestorAccess(db, user, investorId);
  const [s] = await db.select().from(settlements).where(and(eq(settlements.investorId, investorId), eq(settlements.month, month))).limit(1);
  if (s?.status === "LOCKED") {
    const lines = await db.select().from(settlementLines).where(eq(settlementLines.settlementId, s.id));
    return {
      investorId, month, status: "LOCKED", lockedAt: s.lockedAt, commonProvisional: false,
      totalRevenue: s.totalRevenue, totalDirectCost: s.totalDirectCost, totalCommonCost: s.totalCommonCost,
      totalProfit: s.totalProfit, managementFee: s.managementFee, investorNet: s.investorNet,
      lines: lines.map((l) => ({
        propertyId: l.propertyId, roomCount: l.roomCount, soldNights: l.soldNights, availableNights: l.availableNights,
        nightRevenue: l.revenue - l.adjustments, adjustments: l.adjustments, revenue: l.revenue, directCost: l.directCost,
        commonCostAlloc: l.commonCostAlloc, profit: l.profit,
      })),
    };
  }
  const c = await computeSettlement(db, investorId, month);
  const today = D.todayVN();
  return { ...c, investorId, status: D.lastDay(month) < today ? "DRAFT" : "OPEN" };
}

export async function lockSettlement(db: DB, user: SessionUser, investorId: string, month: string) {
  requirePermission(user, "lockSettlement");
  const [inv] = await db.select().from(investors).where(eq(investors.id, investorId)).limit(1);
  if (!inv) throw notFound("Không tìm thấy nhà đầu tư");
  const chk = D.canLockMonth(month, D.todayVN(), await isCommonFinalized(db, month));
  if (!chk.ok) throw badRequest(chk.reason!);
  const c = await computeSettlement(db, investorId, month);
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(settlements).where(and(eq(settlements.investorId, investorId), eq(settlements.month, month))).limit(1);
    if (existing?.status === "LOCKED") throw badRequest("Tháng này đã khóa sổ");
    const values = {
      investorId, month, status: "LOCKED" as const, totalRevenue: c.totalRevenue, totalDirectCost: c.totalDirectCost, totalCommonCost: c.totalCommonCost,
      totalProfit: c.totalProfit, managementFee: c.managementFee, investorNet: c.investorNet, lockedAt: new Date(), lockedById: user.id,
    };
    let id = existing?.id;
    if (id) {
      await tx.update(settlements).set(values).where(eq(settlements.id, id));
      await tx.delete(settlementLines).where(eq(settlementLines.settlementId, id));
    } else {
      [{ id }] = await tx.insert(settlements).values(values).returning({ id: settlements.id });
    }
    if (c.lines.length) {
      await tx.insert(settlementLines).values(c.lines.map((l) => ({
        settlementId: id!, propertyId: l.propertyId, roomCount: l.roomCount, soldNights: l.soldNights, availableNights: l.availableNights,
        revenue: l.revenue, adjustments: l.adjustments, directCost: l.directCost, commonCostAlloc: l.commonCostAlloc, profit: l.profit,
      })));
    }
  });
  return c;
}

export async function unlockSettlement(db: DB, user: SessionUser, investorId: string, month: string, reason: string) {
  requirePermission(user, "lockSettlement");
  if (!reason?.trim()) throw badRequest("Bắt buộc nhập lý do mở khóa");
  const [s] = await db.select().from(settlements).where(and(eq(settlements.investorId, investorId), eq(settlements.month, month))).limit(1);
  if (!s || s.status !== "LOCKED") throw badRequest("Tháng này chưa khóa sổ");
  await db.transaction(async (tx) => {
    await tx.update(settlements).set({ status: "DRAFT", lockedAt: null, lockedById: null }).where(eq(settlements.id, s.id));
    await tx.insert(settlementUnlockLogs).values({ settlementId: s.id, byUserId: user.id, reason: reason.trim() });
  });
}

export async function isPropertyMonthLocked(db: DB, propertyId: string, month: string): Promise<boolean> {
  const [row] = await db
    .select({ status: settlements.status })
    .from(settlements)
    .innerJoin(properties, eq(properties.investorId, settlements.investorId))
    .where(and(eq(properties.id, propertyId), eq(settlements.month, month), eq(settlements.status, "LOCKED")))
    .limit(1);
  return !!row;
}

export async function isAnyInvestorLocked(db: DB, month: string): Promise<boolean> {
  const rows = await db.select({ id: settlements.id }).from(settlements).where(and(eq(settlements.month, month), eq(settlements.status, "LOCKED"))).limit(1);
  return rows.length > 0;
}

// ---- 5.7 Hoàn vốn ----
export async function paybackForInvestor(db: DB, user: SessionUser, investorId: string) {
  await assertInvestorAccess(db, user, investorId);
  const props = await db.select().from(properties).where(eq(properties.investorId, investorId));
  const investmentTotal = props.reduce((s, p) => s + p.investmentAmount, 0);
  const startMonth = props.map((p) => p.investmentStartMonth).filter(Boolean).sort()[0] ?? null;
  const locked = await db
    .select({ month: settlements.month, investorNet: settlements.investorNet })
    .from(settlements)
    .where(and(eq(settlements.investorId, investorId), eq(settlements.status, "LOCKED")))
    .orderBy(asc(settlements.month));
  return { investmentTotal, ...D.payback({ investmentTotal, lockedNets: locked, startMonth }) };
}

// ---- 5.8 Dự kiến tháng hiện tại, theo NĐT ----
export async function investorForecast(db: DB, investorId: string, month: string, today = D.todayVN()) {
  const props = await db.select().from(properties).where(eq(properties.investorId, investorId));
  const pids = props.map((p) => p.id);
  const [roomsAll, nights, exps, finalized, pct, adjs] = await Promise.all([
    allRooms(db),
    nightsBetween(db, pids, D.firstDay(D.prevMonth(month)), D.lastDay(month)),
    expensesFor(db, [month, D.prevMonth(month)], pids),
    isCommonFinalized(db, month),
    feePct(db),
    pids.length ? db.select().from(adjustments).where(and(inArray(adjustments.propertyId, pids), eq(adjustments.appliedMonth, month))) : Promise.resolve([]),
  ]);
  const common = D.commonCostForMonth({ month, expenses: exps, rooms: roomsAll, finalized });
  const lines = props.map((p) => {
    const f = D.forecastProperty({
      month, today, rooms: roomsAll.filter((r) => r.propertyId === p.id), nights: nights.filter((n) => n.propertyId === p.id),
      fixedCostMonthly: p.fixedCostMonthly, variableCostPerNight: p.variableCostPerNight, commonCost: common.perProperty[p.id] ?? 0,
    });
    const adj = adjs.filter((a) => a.propertyId === p.id).reduce((s, a) => s + a.amount, 0);
    const actualCost = exps.filter((e) => e.propertyId === p.id && e.month === month).reduce((s, e) => s + e.amount, 0) + (common.perProperty[p.id] ?? 0);
    return { propertyId: p.id, name: p.name, ...f, revenueForecast: f.revenueForecast + adj, actualCost };
  });
  const revenue = lines.reduce((s, l) => s + l.revenueForecast, 0);
  const cost = lines.reduce((s, l) => s + l.costForecast, 0);
  const profit = revenue - cost;
  const fee = D.managementFee(profit, pct);
  return { lines, revenueForecast: revenue, costForecast: cost, actualCost: lines.reduce((s, l) => s + l.actualCost, 0), profitForecast: profit, managementFee: fee, investorNet: profit - fee, commonProvisional: common.provisional };
}

export { desc };

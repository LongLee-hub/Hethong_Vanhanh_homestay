// Quyết toán, khóa sổ, hoàn vốn, dự kiến (Đặc tả 5.3–5.8). Đọc DB rồi gọi hàm thuần trong lib/domain.
import { cache } from "react";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import {
  adjustments, bookingNights, bookings, expenses, investors, monthPeriods, properties, rooms, settlementLines, settlementUnlockLogs, settlements,
} from "../db/schema";
import { assertInvestorAccess, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { feePct } from "./settings";

export async function isCommonFinalized(db: DB, month: string): Promise<boolean> {
  const [p] = await db.select().from(monthPeriods).where(eq(monthPeriods.month, month)).limit(1);
  return !!p?.commonCostsFinalized;
}

/** Mọi phòng toàn hệ thống, để chia chi phí chung. cache: trang tính cho nhiều NĐT chỉ đọc bảng phòng một lần. */
const allRooms = cache((db: DB) =>
  db.select({ id: rooms.id, propertyId: rooms.propertyId, openedOn: rooms.openedOn, closedOn: rooms.closedOn }).from(rooms),
);

/** Dữ liệu một NĐT cần để tính quyết toán/dự kiến cho các tháng `months`, lấy trong một lượt hỏi DB (các câu chạy song song). */
interface InvestorData {
  props: (typeof properties.$inferSelect)[];
  rooms: D.RoomLite[]; // toàn hệ thống, để chia chi phí chung
  nights: D.NightLite[];
  expenses: D.ExpenseLite[]; // các tháng `months` và tháng liền trước mỗi tháng
  adjustments: D.AdjustmentLite[];
  finalized: Set<string>; // tháng đã chốt chi phí chung
  pct: number;
}

async function loadInvestorData(db: DB, investorId: string, months: string[], nightsFrom?: string): Promise<InvestorData> {
  const ms = [...months].sort();
  const expMonths = [...new Set(ms.flatMap((m) => [D.prevMonth(m), m]))];
  const invProps = db.select({ id: properties.id }).from(properties).where(eq(properties.investorId, investorId));
  const [props, roomRows, nightRows, exps, adjs, periods, pct] = await Promise.all([
    db.select().from(properties).where(eq(properties.investorId, investorId)),
    allRooms(db),
    db
      .select()
      .from(bookingNights)
      .where(and(inArray(bookingNights.propertyId, invProps), gte(bookingNights.nightDate, nightsFrom ?? D.firstDay(ms[0])), lte(bookingNights.nightDate, D.lastDay(ms[ms.length - 1])))),
    db
      .select({ propertyId: expenses.propertyId, month: expenses.month, amount: expenses.amount })
      .from(expenses)
      .where(and(inArray(expenses.month, expMonths), or(isNull(expenses.propertyId), inArray(expenses.propertyId, invProps)))),
    db.select().from(adjustments).where(and(inArray(adjustments.propertyId, invProps), inArray(adjustments.appliedMonth, ms))),
    db.select().from(monthPeriods).where(inArray(monthPeriods.month, ms)),
    feePct(db),
  ]);
  return {
    props,
    rooms: roomRows,
    nights: nightRows.map((n) => ({ bookingId: n.bookingId, propertyId: n.propertyId, roomId: n.roomId, nightDate: n.nightDate, netAmount: n.netAmount, kind: n.kind })),
    expenses: exps,
    adjustments: adjs.map((a) => ({ propertyId: a.propertyId, appliedMonth: a.appliedMonth, amount: a.amount })),
    finalized: new Set(periods.filter((p) => p.commonCostsFinalized).map((p) => p.month)),
    pct,
  };
}

function settleFrom(d: InvestorData, month: string): D.InvestorSettlement {
  return D.settleInvestorMonth({
    month, propertyIds: d.props.map((p) => p.id), rooms: d.rooms, nights: d.nights, expenses: d.expenses,
    adjustments: d.adjustments, commonFinalized: d.finalized.has(month), feePct: d.pct,
  });
}

/** Tính quyết toán từ dữ liệu hiện tại (không đọc bản đã khóa). */
export async function computeSettlement(db: DB, investorId: string, month: string): Promise<D.InvestorSettlement> {
  return settleFrom(await loadInvestorData(db, investorId, [month]), month);
}

export type SettlementView = D.InvestorSettlement & { investorId: string; status: "DRAFT" | "LOCKED" | "OPEN"; lockedAt?: Date | null };

/** Quyết toán để hiển thị: tháng đã khóa đọc từ bảng lưu, không tính lại (5.5). */
export async function getSettlement(db: DB, user: SessionUser, investorId: string, month: string): Promise<SettlementView> {
  return (await getSettlements(db, user, investorId, [month]))[0];
}

/** Như getSettlement cho nhiều tháng, đọc DB chung một lượt. Kết quả theo đúng thứ tự `months`. */
export async function getSettlements(db: DB, user: SessionUser, investorId: string, months: string[]): Promise<SettlementView[]> {
  const [, saved, lockedLines, data] = await Promise.all([
    assertInvestorAccess(db, user, investorId),
    db.select().from(settlements).where(and(eq(settlements.investorId, investorId), inArray(settlements.month, months))),
    db
      .select({ line: settlementLines, month: settlements.month })
      .from(settlementLines)
      .innerJoin(settlements, eq(settlements.id, settlementLines.settlementId))
      .where(and(eq(settlements.investorId, investorId), inArray(settlements.month, months), eq(settlements.status, "LOCKED"))),
    loadInvestorData(db, investorId, months),
  ]);
  const today = D.todayVN();
  return months.map((month): SettlementView => {
    const s = saved.find((r) => r.month === month);
    if (s?.status === "LOCKED") {
      const lines = lockedLines.filter((r) => r.month === month).map((r) => r.line);
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
    return { ...settleFrom(data, month), investorId, status: D.lastDay(month) < today ? "DRAFT" : "OPEN" };
  });
}

/** Cách tính chi phí chung mỗi phòng của một tháng, để hiện công thức cho NĐT. */
export interface CommonCostBasis {
  total: number; // tổng chi phí chung toàn hệ thống của tháng làm căn cứ
  rooms: number; // số phòng hoạt động toàn hệ thống trong tháng đó
  perRoom: number; // chi phí chung mỗi phòng
  provisional: boolean; // true: chưa hoàn tất kê khai, tạm tính theo tháng trước
  basisMonth: string;
}

/**
 * Căn cứ chia chi phí chung, khớp với commonCostForMonth trong lib/domain:
 * đã kê khai xong → tổng tháng này ÷ phòng tháng này; chưa xong → mức mỗi phòng của tháng trước.
 * `locked`: tháng đã khóa sổ luôn dùng số đã kê khai của chính tháng đó.
 */
export async function commonCostBasis(db: DB, month: string, locked = false): Promise<CommonCostBasis> {
  const pm = D.prevMonth(month);
  const [roomRows, exps, finalized] = await Promise.all([
    allRooms(db),
    db.select({ month: expenses.month, amount: expenses.amount }).from(expenses).where(and(isNull(expenses.propertyId), inArray(expenses.month, [month, pm]))),
    locked ? Promise.resolve(true) : isCommonFinalized(db, month),
  ]);
  const roomCount = (m: string) => Object.values(D.activeRoomCountByProperty(roomRows, m)).reduce((s, n) => s + n, 0);
  const totalOf = (m: string) => exps.filter((e) => e.month === m).reduce((s, e) => s + e.amount, 0);
  const basisMonth = finalized ? month : pm;
  const total = totalOf(basisMonth);
  const n = roomCount(basisMonth);
  const perRoom = n ? (finalized ? total / n : Math.floor(total / n)) : 0;
  return { total, rooms: n, perRoom, provisional: !finalized, basisMonth };
}

/** Các khoản điều chỉnh được ghi vào tháng `month` cho các cơ sở của NĐT, kèm đơn gốc nếu có. */
export async function adjustmentDetails(db: DB, user: SessionUser, investorId: string, month: string) {
  await assertInvestorAccess(db, user, investorId);
  return db
    .select({
      id: adjustments.id, propertyId: adjustments.propertyId, originalMonth: adjustments.originalMonth, amount: adjustments.amount,
      reason: adjustments.reason, externalId: bookings.externalId, channel: bookings.channel,
    })
    .from(adjustments)
    .innerJoin(properties, eq(properties.id, adjustments.propertyId))
    .leftJoin(bookings, eq(bookings.id, adjustments.bookingId))
    .where(and(eq(properties.investorId, investorId), eq(adjustments.appliedMonth, month)))
    .orderBy(asc(adjustments.createdAt));
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
  const [, props, locked] = await Promise.all([
    assertInvestorAccess(db, user, investorId),
    db.select().from(properties).where(eq(properties.investorId, investorId)),
    db
      .select({ month: settlements.month, investorNet: settlements.investorNet })
      .from(settlements)
      .where(and(eq(settlements.investorId, investorId), eq(settlements.status, "LOCKED")))
      .orderBy(asc(settlements.month)),
  ]);
  const investmentTotal = props.reduce((s, p) => s + p.investmentAmount, 0);
  const startMonth = props.map((p) => p.investmentStartMonth).filter(Boolean).sort()[0] ?? null;
  return { investmentTotal, ...D.payback({ investmentTotal, lockedNets: locked, startMonth }) };
}

// ---- 5.8 Dự kiến tháng hiện tại, theo NĐT ----
export async function investorForecast(db: DB, investorId: string, month: string, today = D.todayVN()) {
  // Lấy thêm đêm của tháng trước để ước công suất cho đêm còn trống
  const d = await loadInvestorData(db, investorId, [month], D.firstDay(D.prevMonth(month)));
  const { props, rooms: roomsAll, nights, expenses: exps, adjustments: adjs, pct } = d;
  const finalized = d.finalized.has(month);
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

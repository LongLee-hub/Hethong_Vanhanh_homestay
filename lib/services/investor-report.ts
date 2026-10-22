// Báo cáo NĐT theo mẫu bc-ndt: tách chi phí thành 5 nhóm (Homestay, Host, Thuế, BHXH, Kế toán)
// cho 1 cơ sở hoặc toàn bộ cơ sở của một NĐT, kèm 3 tháng liền trước để so sánh.
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { bookingNights, expenseCategories, expenses, properties, rooms } from "../db/schema";
import { notFound, type SessionUser } from "../auth/access";
import { getSettlements } from "./settlement";

/** Loại chi phí được tách khỏi CP Homestay, nhận theo tên loại. */
const isTax = (name: string) => /thuế/i.test(name);
const isBhxh = (name: string) => /bhxh|bảo hiểm xã hội/i.test(name);
const isAccounting = (name: string) => /kế toán/i.test(name);

export const COMMON_ROW = "Chi phí chung được chia";

export interface ReportMonth {
  month: string;
  hasData: boolean;
  revenue: number;
  homestay: number; // chi phí cơ sở + chi phí chung, trừ các nhóm tách riêng
  host: number; // phí quản lý LOCI
  tax: number;
  vat: number; // GTGT = DT × 8/108, không vượt quá CP Thuế đã nhập; CĐT đặc biệt: GTGT tự tính
  cit: number; // TNDN = CP Thuế − GTGT; CĐT đặc biệt: TNCN tự tính
  /** CĐT đặc biệt (vd Uxistay): thuế tự tính theo mức trong hồ sơ NĐT thay cho khoản chi loại "Thuế". null = CĐT thường. */
  autoTax: { vatPct: number; pitPct: number } | null;
  bhxh: number;
  accounting: number;
  net: number; // về tay NĐT
  homestayByCategory: Record<string, number>;
}

/** Doanh thu từng phòng trong tháng báo cáo, tính tới ngày hiện tại. */
export interface RoomRevenue {
  roomId: string;
  name: string; // "Cơ sở. Phòng"
  revenue: number; // doanh thu đêm từ đầu tháng tới hết ngày đã qua
  projected: number; // dự kiến cả tháng = DT ÷ số ngày đã qua × số ngày trong tháng
  kpi: number; // KPI doanh thu tháng, 0 = chưa đặt
}

export interface RoomRevenueReport {
  elapsedDays: number; // số ngày đã qua của tháng báo cáo (tính cả hôm nay)
  daysInMonth: number;
  rows: RoomRevenue[];
}

export interface InvestorReport {
  months: ReportMonth[]; // cũ → mới, phần tử cuối là tháng báo cáo
  rooms: RoomRevenueReport;
  propertyIds: string[];
  status: "DRAFT" | "LOCKED" | "OPEN";
  commonProvisional: boolean;
}

/** propertyId = null: gộp toàn bộ cơ sở của NĐT. */
export async function buildInvestorReport(db: DB, user: SessionUser, investorId: string, month: string, propertyId: string | null): Promise<InvestorReport> {
  const list = [D.prevMonth(D.prevMonth(D.prevMonth(month))), D.prevMonth(D.prevMonth(month)), D.prevMonth(month), month];
  const settled = await getSettlements(db, user, investorId, list);
  const scoped = settled.map((s) => ({ s, lines: propertyId ? s.lines.filter((l) => l.propertyId === propertyId) : s.lines }));
  if (propertyId && scoped.some((x) => !x.lines.length)) throw notFound("Cơ sở không thuộc nhà đầu tư này");
  const current = settled[settled.length - 1];
  const propertyIds = scoped[scoped.length - 1].lines.map((l) => l.propertyId);

  // Chi phí theo loại của cả 4 tháng và doanh thu từng phòng: đọc song song
  const allPids = [...new Set(scoped.flatMap((x) => x.lines.map((l) => l.propertyId)))];
  const [catRows, roomsReport] = await Promise.all([
    allPids.length
      ? db
          .select({ month: expenses.month, propertyId: expenses.propertyId, name: expenseCategories.name, amount: expenses.amount })
          .from(expenses)
          .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
          .where(and(eq(expenses.approvalStatus, "APPROVED"), inArray(expenses.month, list), inArray(expenses.propertyId, allPids)))
      : [],
    roomRevenue(db, propertyIds, month),
  ]);

  const months: ReportMonth[] = scoped.map(({ s, lines }, i) => {
    const m = list[i];
    const pids = lines.map((l) => l.propertyId);
    const revenue = lines.reduce((t, l) => t + l.revenue, 0);
    const direct = lines.reduce((t, l) => t + l.directCost, 0);
    const common = lines.reduce((t, l) => t + l.commonCostAlloc, 0);
    // Phí quản lý (và thuế tự tính của CĐT đặc biệt) tính trên lãi của NĐT; xem riêng 1 cơ sở thì tính trên lãi của cơ sở đó.
    const auto = s.vatPct > 0 || s.pitPct > 0 ? { vatPct: s.vatPct, pitPct: s.pitPct } : null;
    const t = propertyId
      ? D.feeAndTaxes({ revenue, profit: lines[0].profit, feePct: s.feePct, vatPct: s.vatPct, pitPct: s.pitPct })
      : { fee: s.managementFee, vat: s.vat, pit: s.pit };
    const host = t.fee;

    const byCat: Record<string, number> = {};
    for (const r of catRows) {
      if (r.month !== m || !r.propertyId || !pids.includes(r.propertyId)) continue;
      const name = r.name.normalize("NFC");
      byCat[name] = (byCat[name] ?? 0) + r.amount;
    }
    const sumWhere = (f: (n: string) => boolean) => Object.entries(byCat).filter(([n]) => f(n)).reduce((t, [, a]) => t + a, 0);
    // CĐT đặc biệt: CP Thuế là thuế tự tính; khoản chi loại "Thuế" nếu có vẫn trừ trong quyết toán nên để ở CP Homestay
    const declaredTax = auto ? 0 : sumWhere(isTax);
    const bhxh = sumWhere(isBhxh);
    const accounting = sumWhere(isAccounting);

    const homestayByCategory = Object.fromEntries(Object.entries(byCat).filter(([n]) => (auto || !isTax(n)) && !isBhxh(n) && !isAccounting(n)));
    if (common) homestayByCategory[COMMON_ROW] = common;

    const vat = auto ? t.vat : Math.min(declaredTax, Math.max(0, Math.round((revenue * 8) / 108)));
    const tax = auto ? t.vat + t.pit : declaredTax;
    return {
      month: m,
      hasData: revenue !== 0 || direct !== 0 || common !== 0,
      revenue,
      homestay: direct + common - declaredTax - bhxh - accounting,
      host,
      tax,
      vat,
      cit: tax - vat,
      autoTax: auto,
      bhxh,
      accounting,
      net: revenue - direct - common - host - (auto ? tax : 0),
      homestayByCategory,
    };
  });

  return { months, rooms: roomsReport, propertyIds, status: current.status, commonProvisional: current.status !== "LOCKED" && current.commonProvisional };
}

async function roomRevenue(db: DB, propertyIds: string[], month: string): Promise<RoomRevenueReport> {
  const dim = D.daysInMonth(month);
  const today = D.todayVN();
  const elapsedDays = month < D.monthOf(today) ? dim : month === D.monthOf(today) ? Number(today.slice(8, 10)) : 0;
  if (!propertyIds.length || !elapsedDays) return { elapsedDays, daysInMonth: dim, rows: [] };

  const to = month === D.monthOf(today) ? today : D.lastDay(month);
  const [nights, list] = await Promise.all([
    db
      .select({ roomId: bookingNights.roomId, amount: bookingNights.netAmount })
      .from(bookingNights)
      .where(and(inArray(bookingNights.propertyId, propertyIds), gte(bookingNights.nightDate, D.firstDay(month)), lte(bookingNights.nightDate, to))),
    db
      .select({ id: rooms.id, name: rooms.name, propName: properties.name, openedOn: rooms.openedOn, closedOn: rooms.closedOn, kpi: rooms.revenueKpiMonthly })
      .from(rooms)
      .innerJoin(properties, eq(properties.id, rooms.propertyId))
      .where(inArray(rooms.propertyId, propertyIds))
      .orderBy(asc(properties.name), asc(rooms.name)),
  ]);
  const byRoom = new Map<string, number>();
  for (const n of nights) byRoom.set(n.roomId, (byRoom.get(n.roomId) ?? 0) + n.amount);

  const rows = list
    // Phòng mở bán trong tháng, hoặc đã đóng nhưng vẫn có doanh thu tháng này
    .filter((r) => byRoom.has(r.id) || (r.openedOn <= D.lastDay(month) && (!r.closedOn || r.closedOn > D.firstDay(month))))
    .map((r) => {
      const revenue = byRoom.get(r.id) ?? 0;
      return { roomId: r.id, name: r.name.includes(r.propName) ? r.name : `${r.propName}. ${r.name}`, revenue, projected: Math.round((revenue * dim) / elapsedDays), kpi: r.kpi };
    });
  return { elapsedDays, daysInMonth: dim, rows };
}

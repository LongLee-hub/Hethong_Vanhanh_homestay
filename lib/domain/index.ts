// Logic nghiệp vụ thuần của LOCI Homestay Manager.
// Không truy cập database. Mọi số tiền là số nguyên VND.
// Tham chiếu: Đặc tả mục 5 (Quy tắc nghiệp vụ và công thức).

import {
  ISODate,
  Month,
  addDays,
  diffDays,
  eachDay,
  firstDay,
  lastDay,
  monthOf,
  prevMonth,
} from "./dates";

export * from "./dates";

// ---------- Kiểu dữ liệu tối thiểu mà domain cần ----------

export interface RoomLite {
  id: string;
  propertyId: string;
  openedOn: ISODate;
  closedOn?: ISODate | null; // null = đang hoạt động
}

export interface BookingLite {
  id: string;
  propertyId: string;
  roomId: string;
  checkIn: ISODate;
  checkOut: ISODate;
  netAmount: number;
  status: "CONFIRMED" | "CANCELLED";
  bookedAt?: ISODate | null;
  channel?: string;
  rentalType?: string | null; // loại thuê Dayladau (type_rental); null = thuê theo đêm
}

/** NIGHT = đêm bán; HOURLY = lượt thuê giờ; CANCEL_FEE = phí hủy. Chỉ NIGHT tính vào công suất. */
export type NightKind = "NIGHT" | "HOURLY" | "CANCEL_FEE";

export interface NightLite {
  bookingId: string;
  propertyId: string;
  roomId: string;
  nightDate: ISODate;
  netAmount: number;
  kind?: NightKind; // bỏ trống = NIGHT
}

/** Loại thuê Dayladau tính là lượt thuê giờ (Quy chế doanh thu, Điều 4). Qua đêm ngắn vẫn là đêm bán. */
export const HOURLY_RENTAL_TYPES = ["hourly_rental", "special_offer_time_rental"];
export const isHourlyRental = (t?: string | null) => !!t && HOURLY_RENTAL_TYPES.includes(t);
const isSoldNight = (n: NightLite) => (n.kind ?? "NIGHT") === "NIGHT";

export interface ExpenseLite {
  propertyId: string | null; // null = chi phí chung
  month: Month;
  amount: number;
}

export interface AdjustmentLite {
  propertyId: string;
  appliedMonth: Month;
  amount: number;
}

function assertInt(n: number, label: string) {
  if (!Number.isSafeInteger(n)) throw new Error(`${label} phải là số nguyên VND, nhận ${n}`);
}

// ---------- 5.1 Phân bổ doanh thu theo đêm ----------

/**
 * Tách một đơn thành các đêm phòng.
 * - Đêm: checkIn .. checkOut-1
 * - Mỗi đêm = floor(net / số đêm), phần dư cộng vào đêm cuối.
 * - Đơn CANCELLED: không có đêm; nếu còn net > 0 (phí hủy) ghi toàn bộ vào ngày checkIn, loại CANCEL_FEE.
 * - Thuê giờ: một lượt HOURLY vào ngày checkIn, không tính là đêm bán.
 */
export function splitNights(b: BookingLite): NightLite[] {
  assertInt(b.netAmount, "netAmount");
  const base = { bookingId: b.id, propertyId: b.propertyId, roomId: b.roomId };
  if (b.status === "CANCELLED") {
    return b.netAmount > 0 ? [{ ...base, nightDate: b.checkIn, netAmount: b.netAmount, kind: "CANCEL_FEE" }] : [];
  }
  if (isHourlyRental(b.rentalType)) return [{ ...base, nightDate: b.checkIn, netAmount: b.netAmount, kind: "HOURLY" }];
  const n = diffDays(b.checkOut, b.checkIn);
  if (n <= 0) throw new Error(`Đơn ${b.id}: checkOut phải sau checkIn`);
  const per = Math.floor(b.netAmount / n);
  const remainder = b.netAmount - per * n;
  const nights: NightLite[] = [];
  for (let i = 0; i < n; i++) {
    nights.push({
      ...base,
      nightDate: addDays(b.checkIn, i),
      netAmount: per + (i === n - 1 ? remainder : 0),
      kind: "NIGHT",
    });
  }
  return nights;
}

export function nightsInRange(nights: NightLite[], from: ISODate, to: ISODate): NightLite[] {
  return nights.filter((n) => n.nightDate >= from && n.nightDate <= to);
}

// ---------- 5.2 Chỉ số vận hành ----------

export function isRoomActiveOn(r: RoomLite, d: ISODate): boolean {
  return r.openedOn <= d && (!r.closedOn || r.closedOn > d);
}

/** Đêm có sẵn: tổng số phòng hoạt động của từng ngày trong khoảng. */
export function availableNights(rooms: RoomLite[], from: ISODate, to: ISODate): number {
  if (to < from) return 0;
  let total = 0;
  for (const d of eachDay(from, to)) for (const r of rooms) if (isRoomActiveOn(r, d)) total++;
  return total;
}

export interface Kpis {
  soldNights: number;
  hourlyCount: number; // lượt thuê giờ, không tính vào công suất
  availableNights: number;
  revenue: number;
  occupancyPct: number; // 0..100, 1 chữ số thập phân
  adr: number; // VND, làm tròn xuống
  revpar: number;
}

export function computeKpis(nights: NightLite[], rooms: RoomLite[], from: ISODate, to: ISODate): Kpis {
  const inRange = nightsInRange(nights, from, to);
  // Doanh thu gồm cả lượt thuê giờ và phí hủy; công suất và giá trung bình/đêm chỉ xét đêm bán.
  const soldList = inRange.filter(isSoldNight);
  const sold = soldList.length;
  const avail = availableNights(rooms, from, to);
  const revenue = inRange.reduce((s, n) => s + n.netAmount, 0);
  const nightRevenue = soldList.reduce((s, n) => s + n.netAmount, 0);
  return {
    soldNights: sold,
    hourlyCount: inRange.filter((n) => n.kind === "HOURLY").length,
    availableNights: avail,
    revenue,
    occupancyPct: avail ? Math.round((sold / avail) * 1000) / 10 : 0,
    adr: sold ? Math.floor(nightRevenue / sold) : 0,
    revpar: avail ? Math.floor(revenue / avail) : 0,
  };
}

export const LEAD_TIME_BUCKETS = ["0–1", "2–7", "8–14", "15–30", ">30"] as const;

export function leadTimeBucket(checkIn: ISODate, bookedAt: ISODate): (typeof LEAD_TIME_BUCKETS)[number] {
  const d = diffDays(checkIn, bookedAt);
  if (d <= 1) return "0–1";
  if (d <= 7) return "2–7";
  if (d <= 14) return "8–14";
  if (d <= 30) return "15–30";
  return ">30";
}

export function leadTimeDistribution(bookings: BookingLite[]): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(LEAD_TIME_BUCKETS.map((b) => [b, 0]));
  for (const b of bookings) if (b.bookedAt && b.status === "CONFIRMED") out[leadTimeBucket(b.checkIn, b.bookedAt)]++;
  return out;
}

// ---------- 5.3 Chi phí chung ----------

/**
 * Số phòng hoạt động của tháng theo cơ sở: phòng hoạt động ít nhất 1 ngày trong tháng.
 * TODO(CONFIRM): có chia theo số ngày hoạt động không.
 */
export function activeRoomCountByProperty(rooms: RoomLite[], month: Month): Record<string, number> {
  const from = firstDay(month);
  const to = lastDay(month);
  const out: Record<string, number> = {};
  for (const r of rooms) {
    const activeSomeDay = r.openedOn <= to && (!r.closedOn || r.closedOn > from);
    if (activeSomeDay) out[r.propertyId] = (out[r.propertyId] ?? 0) + 1;
  }
  return out;
}

/**
 * Chia chi phí chung đều theo phòng trên toàn hệ thống.
 * Phần dư dồn vào cơ sở nhiều phòng nhất để tổng khớp đúng.
 */
export function allocateCommonCost(total: number, roomsByProperty: Record<string, number>): Record<string, number> {
  assertInt(total, "Chi phí chung");
  const ids = Object.keys(roomsByProperty).filter((id) => roomsByProperty[id] > 0);
  const totalRooms = ids.reduce((s, id) => s + roomsByProperty[id], 0);
  const out: Record<string, number> = {};
  if (!totalRooms) return out;
  let allocated = 0;
  for (const id of ids) {
    out[id] = Math.floor((total * roomsByProperty[id]) / totalRooms);
    allocated += out[id];
  }
  const biggest = ids.reduce((a, b) => (roomsByProperty[b] > roomsByProperty[a] ? b : a));
  out[biggest] += total - allocated;
  return out;
}

/**
 * Chi phí chung phân bổ cho tháng. Nếu chưa hoàn tất kê khai, dùng số tạm tính:
 * CP chung mỗi phòng của tháng trước × số phòng.
 */
export function commonCostForMonth(opts: {
  month: Month;
  expenses: ExpenseLite[];
  rooms: RoomLite[];
  finalized: boolean;
}): { perProperty: Record<string, number>; provisional: boolean; total: number } {
  const { month, expenses, rooms, finalized } = opts;
  const rooms_ = activeRoomCountByProperty(rooms, month);
  if (finalized) {
    const total = expenses.filter((e) => e.propertyId === null && e.month === month).reduce((s, e) => s + e.amount, 0);
    return { perProperty: allocateCommonCost(total, rooms_), provisional: false, total };
  }
  const pm = prevMonth(month);
  const prevTotal = expenses.filter((e) => e.propertyId === null && e.month === pm).reduce((s, e) => s + e.amount, 0);
  const prevRooms = Object.values(activeRoomCountByProperty(rooms, pm)).reduce((s, n) => s + n, 0);
  const perRoom = prevRooms ? Math.floor(prevTotal / prevRooms) : 0;
  const perProperty: Record<string, number> = {};
  let total = 0;
  for (const [pid, n] of Object.entries(rooms_)) {
    perProperty[pid] = perRoom * n;
    total += perRoom * n;
  }
  return { perProperty, provisional: true, total };
}

/** Loại chi phí tháng nào cũng phải có; thiếu thì trang Chi phí cảnh báo. Lương thường kê khai là chi phí chung. */
export const REQUIRED_EXPENSE_CATEGORIES = ["Thuê nhà", "Internet", "Vật tư tiêu hao", "Lương", "Bảo trì", "Điện nước"];

/**
 * Mỗi cơ sở còn thiếu loại chi phí bắt buộc nào trong tháng. Khoản đã kê khai (chờ duyệt hoặc đã duyệt) coi là có,
 * khoản bị từ chối coi như chưa có. Khoản chi phí chung (propertyId null) tính là có cho mọi cơ sở.
 * Chỉ trả về cơ sở còn thiếu, giữ thứ tự propertyIds.
 */
export function missingExpenseCategories(opts: {
  propertyIds: string[];
  expenses: { propertyId: string | null; categoryId: string; approvalStatus: string }[];
  categoryName: Record<string, string>;
  required?: string[];
}): { propertyId: string; missing: string[] }[] {
  const required = opts.required ?? REQUIRED_EXPENSE_CATEGORIES;
  const norm = (s: string) => s.normalize("NFC").trim().toLowerCase();
  const has = new Map<string | null, Set<string>>();
  for (const e of opts.expenses) {
    if (e.approvalStatus === "REJECTED") continue;
    const name = opts.categoryName[e.categoryId] && norm(opts.categoryName[e.categoryId]);
    if (!name) continue;
    if (!has.has(e.propertyId)) has.set(e.propertyId, new Set());
    has.get(e.propertyId)!.add(name);
  }
  const common = has.get(null) ?? new Set<string>();
  const out: { propertyId: string; missing: string[] }[] = [];
  for (const pid of opts.propertyIds) {
    const own = has.get(pid) ?? new Set<string>();
    const missing = required.filter((c) => !own.has(norm(c)) && !common.has(norm(c)));
    if (missing.length) out.push({ propertyId: pid, missing });
  }
  return out;
}

// ---------- 5.4 Quyết toán tháng ----------

export interface PropertyLine {
  propertyId: string;
  roomCount: number;
  soldNights: number;
  availableNights: number;
  nightRevenue: number;
  adjustments: number;
  revenue: number; // nightRevenue + adjustments
  directCost: number;
  commonCostAlloc: number;
  profit: number;
}

export interface InvestorSettlement {
  month: Month;
  lines: PropertyLine[];
  totalRevenue: number;
  totalDirectCost: number;
  totalCommonCost: number;
  /** Tổng lợi nhuận các cơ sở (doanh thu − chi phí), chưa trừ thuế. */
  operatingProfit: number;
  /** Lợi nhuận trước phí quản lý = operatingProfit − GTGT. CĐT không chịu thuế thì bằng operatingProfit. */
  totalProfit: number;
  managementFee: number;
  vatPct: number;
  vat: number;
  pitPct: number;
  pit: number;
  investorNet: number;
  commonProvisional: boolean;
}

/** Phí quản lý: floor(LN × pct%) nếu LN > 0, ngược lại 0. */
export function managementFee(profit: number, feePct: number): number {
  assertInt(profit, "Lợi nhuận");
  return profit > 0 ? Math.floor((profit * feePct) / 100) : 0;
}

/**
 * Phí quản lý và thuế của CĐT đặc biệt (vd Uxistay), theo thứ tự:
 * GTGT nằm trong doanh thu = DT × vatPct/(100 + vatPct) → lợi nhuận trước phí = lợi nhuận − GTGT → phí quản lý trên lợi nhuận đó
 * → TNCN = pitPct % phần còn lại sau phí. CĐT thường để 0 nên kết quả như cũ.
 */
export function feeAndTaxes(opts: { revenue: number; profit: number; feePct: number; vatPct?: number; pitPct?: number }): {
  vat: number; profitBeforeFee: number; fee: number; pit: number; investorNet: number;
} {
  const { revenue, profit, feePct, vatPct = 0, pitPct = 0 } = opts;
  assertInt(revenue, "Doanh thu");
  // Doanh thu đã gồm VAT: VAT = DT × vatPct / (100 + vatPct), vd 8% → DT × 8/108
  const vat = revenue > 0 && vatPct > 0 ? Math.floor((revenue * vatPct) / (100 + vatPct)) : 0;
  const profitBeforeFee = profit - vat;
  const fee = managementFee(profitBeforeFee, feePct);
  const afterFee = profitBeforeFee - fee;
  const pit = afterFee > 0 ? Math.floor((afterFee * pitPct) / 100) : 0;
  return { vat, profitBeforeFee, fee, pit, investorNet: afterFee - pit };
}

export function settleInvestorMonth(opts: {
  month: Month;
  propertyIds: string[];
  rooms: RoomLite[]; // toàn hệ thống (để chia chi phí chung)
  nights: NightLite[];
  expenses: ExpenseLite[];
  adjustments: AdjustmentLite[];
  commonFinalized: boolean;
  feePct: number;
  vatPct?: number;
  pitPct?: number;
}): InvestorSettlement {
  const { month, propertyIds, rooms, nights, expenses, adjustments, commonFinalized, feePct, vatPct = 0, pitPct = 0 } = opts;
  const from = firstDay(month);
  const to = lastDay(month);
  const common = commonCostForMonth({ month, expenses, rooms, finalized: commonFinalized });
  const roomsByProp = activeRoomCountByProperty(rooms, month);

  const lines: PropertyLine[] = propertyIds.map((pid) => {
    const pRooms = rooms.filter((r) => r.propertyId === pid);
    const pNights = nights.filter((n) => n.propertyId === pid);
    const k = computeKpis(pNights, pRooms, from, to);
    const adj = adjustments.filter((a) => a.propertyId === pid && a.appliedMonth === month).reduce((s, a) => s + a.amount, 0);
    const direct = expenses.filter((e) => e.propertyId === pid && e.month === month).reduce((s, e) => s + e.amount, 0);
    const commonAlloc = common.perProperty[pid] ?? 0;
    const revenue = k.revenue + adj;
    return {
      propertyId: pid,
      roomCount: roomsByProp[pid] ?? 0,
      soldNights: k.soldNights,
      availableNights: k.availableNights,
      nightRevenue: k.revenue,
      adjustments: adj,
      revenue,
      directCost: direct,
      commonCostAlloc: commonAlloc,
      profit: revenue - direct - commonAlloc,
    };
  });

  const sum = (f: (l: PropertyLine) => number) => lines.reduce((s, l) => s + f(l), 0);
  const operatingProfit = sum((l) => l.profit);
  const totalRevenue = sum((l) => l.revenue);
  const t = feeAndTaxes({ revenue: totalRevenue, profit: operatingProfit, feePct, vatPct, pitPct });
  return {
    month,
    lines,
    totalRevenue,
    totalDirectCost: sum((l) => l.directCost),
    totalCommonCost: sum((l) => l.commonCostAlloc),
    operatingProfit,
    totalProfit: t.profitBeforeFee,
    managementFee: t.fee,
    vatPct,
    vat: t.vat,
    pitPct,
    pit: t.pit,
    investorNet: t.investorNet,
    commonProvisional: common.provisional,
  };
}

// ---------- 5.5 Khóa sổ ----------

export function canLockMonth(month: Month, today: ISODate, commonFinalized: boolean): { ok: boolean; reason?: string } {
  if (lastDay(month) >= today) return { ok: false, reason: "Tháng chưa kết thúc" };
  if (!commonFinalized) return { ok: false, reason: "Kế toán chưa hoàn tất kê khai chi phí chung" };
  return { ok: true };
}

// ---------- 5.6 Điều chỉnh cho tháng đã khóa ----------

/**
 * So sánh đêm cũ và mới của một đơn; trả về chênh lệch doanh thu cho từng tháng đã khóa.
 */
export function lockedMonthDeltas(
  oldNights: NightLite[],
  newNights: NightLite[],
  lockedMonths: Set<Month>,
): { month: Month; propertyId: string; delta: number }[] {
  const acc = new Map<string, number>();
  const add = (n: NightLite, sign: 1 | -1) => {
    const m = monthOf(n.nightDate);
    if (!lockedMonths.has(m)) return;
    const key = `${m}|${n.propertyId}`;
    acc.set(key, (acc.get(key) ?? 0) + sign * n.netAmount);
  };
  oldNights.forEach((n) => add(n, -1));
  newNights.forEach((n) => add(n, 1));
  return [...acc.entries()]
    .filter(([, d]) => d !== 0)
    .map(([k, delta]) => {
      const [month, propertyId] = k.split("|");
      return { month, propertyId, delta };
    });
}

// ---------- 5.7 Hoàn vốn ----------

export function payback(opts: {
  investmentTotal: number;
  lockedNets: { month: Month; investorNet: number }[]; // các tháng đã khóa
  startMonth?: Month | null;
}): { received: number; remaining: number; avgLast3: number | null; monthsLeft: number | null } {
  const rows = opts.lockedNets
    .filter((r) => !opts.startMonth || r.month >= opts.startMonth)
    .sort((a, b) => a.month.localeCompare(b.month));
  const received = rows.reduce((s, r) => s + r.investorNet, 0);
  const remaining = opts.investmentTotal - received;
  const last3 = rows.slice(-3);
  const avg = last3.length ? Math.floor(last3.reduce((s, r) => s + r.investorNet, 0) / last3.length) : null;
  let monthsLeft: number | null = null;
  if (remaining <= 0) monthsLeft = 0;
  else if (avg !== null && avg > 0) monthsLeft = Math.round((remaining / avg) * 10) / 10;
  return { received, remaining, avgLast3: avg, monthsLeft };
}

// ---------- 5.8 Doanh thu và lợi nhuận dự kiến ----------

export interface Forecast {
  revenuePast: number;
  revenueFutureBooked: number;
  revenueEstimatedEmpty: number;
  revenueForecast: number;
  soldPast: number; // đêm bán từ đầu tháng tới hết đêm nay
  hourlyPast: number; // lượt thuê giờ từ đầu tháng tới hôm nay
  bookedFuture: number; // đêm bán đã đặt từ ngày mai tới cuối tháng
  emptyRemaining: number;
  expectedSold: number;
  costForecast: number;
  adrUsed: number;
  prevOccupancy: number; // 0..1
}

export function forecastProperty(opts: {
  month: Month;
  today: ISODate;
  rooms: RoomLite[]; // của cơ sở
  nights: NightLite[]; // của cơ sở
  fixedCostMonthly: number;
  variableCostPerNight: number;
  commonCost: number;
}): Forecast {
  const { month, today, rooms, nights } = opts;
  const from = firstDay(month);
  const to = lastDay(month);
  // Quy chế doanh thu, Điều 1: đêm hôm nay tính là đã thực hiện (theo lịch nhận phòng).
  const past = nights.filter((n) => n.nightDate >= from && n.nightDate <= to && n.nightDate <= today);
  const tomorrow = addDays(today, 1);
  const futureFrom = tomorrow < from ? from : tomorrow;
  const future = futureFrom > to ? [] : nightsInRange(nights, futureFrom, to);
  const futureSold = future.filter(isSoldNight);
  const pastSold = past.filter(isSoldNight);
  const availFuture = futureFrom > to ? 0 : availableNights(rooms, futureFrom, to);
  const empty = Math.max(0, availFuture - futureSold.length);

  const pm = prevMonth(month);
  const prevK = computeKpis(nights, rooms, firstDay(pm), lastDay(pm));
  // Công suất không thể quá 100%; vượt là do ngày mở bán của phòng sai, đừng để nó nhân doanh thu ước tính
  const prevOcc = prevK.availableNights ? Math.min(1, prevK.soldNights / prevK.availableNights) : 0;
  const curSold = pastSold.length + futureSold.length;
  const curRev = [...pastSold, ...futureSold].reduce((s, n) => s + n.netAmount, 0);
  const adr = curSold ? Math.floor(curRev / curSold) : prevK.adr;

  const revenuePast = past.reduce((s, n) => s + n.netAmount, 0);
  const revenueFuture = future.reduce((s, n) => s + n.netAmount, 0);

  // Doanh thu dự kiến theo tốc độ bình quân ngày: doanh thu đến hôm nay ÷ số ngày đã qua (tính cả hôm nay) × số ngày của tháng.
  // Tháng chưa tới: chưa có ngày nào để lấy bình quân, dùng doanh thu các đêm đã đặt. Tháng đã qua: bằng đúng doanh thu thực tế.
  const daysInMonth = Number(to.slice(8, 10));
  const daysElapsed = today < from ? 0 : today > to ? daysInMonth : Number(today.slice(8, 10));
  const revenueForecast = daysElapsed ? Math.round((revenuePast / daysElapsed) * daysInMonth) : revenueFuture;
  const expectedSold = daysElapsed ? (pastSold.length / daysElapsed) * daysInMonth : futureSold.length;
  const cost =
    opts.fixedCostMonthly + Math.floor(opts.variableCostPerNight * expectedSold) + opts.commonCost;
  return {
    revenuePast,
    revenueFutureBooked: revenueFuture,
    revenueEstimatedEmpty: Math.max(0, revenueForecast - revenuePast - revenueFuture),
    revenueForecast,
    soldPast: pastSold.length,
    hourlyPast: past.filter((n) => n.kind === "HOURLY").length,
    bookedFuture: futureSold.length,
    emptyRemaining: empty,
    expectedSold: Math.round(expectedSold * 10) / 10,
    costForecast: cost,
    adrUsed: adr,
    prevOccupancy: prevOcc,
  };
}

// ---------- Định dạng ----------

export function formatVND(n: number): string {
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") + " ₫";
}

export function formatDateVN(d: ISODate): string {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

export function formatMonthVN(m: Month): string {
  const [y, mo] = m.split("-");
  return `Tháng ${Number(mo)}/${y}`;
}

// ---------- 5.9 Chỉ tiêu tháng (KPI) ----------

/**
 * Chi phí dự kiến không được thấp hơn số đã chi thực tế trong tháng.
 * Mô hình (chi phí cố định + biến đổi theo đêm + chi phí chung) chỉ là sàn khi chưa nhập đủ chi phí.
 */
export function costForecastWithActual(modelCost: number, actualCost: number): number {
  return Math.max(modelCost, actualCost);
}

export interface KpiTarget {
  revenue: number; // VND cả tháng
  occupancyPct: number; // 0..100, trên đêm mở bán
  adr: number; // VND/đêm, tính gộp (doanh thu gồm thuê giờ ÷ đêm bán)
}

export interface KpiActual {
  revenue: number; // doanh thu đến hôm nay (gồm thuê giờ, phí hủy)
  soldNights: number; // đêm bán đến hết đêm nay
  availableNights: number; // đêm mở bán từ đầu tháng đến hết hôm nay
}

export type KpiStatus = "ok" | "warn" | "bad" | "none";

export interface KpiItem {
  actual: number;
  target: number | null;
  pct: number | null; // % so với mục tiêu cả tháng (0..∞), 1 chữ số thập phân
  pacePct: number | null; // vạch cần đạt theo tiến độ, % mục tiêu
  status: KpiStatus;
}

export interface KpiProgress {
  daysElapsed: number;
  daysInMonth: number;
  revenue: KpiItem & { forecast: number; forecastPct: number | null };
  occupancy: KpiItem;
  adr: KpiItem;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Xanh khi đạt ≥ 100% mức cần, vàng khi thiếu dưới 10%, đỏ khi thiếu từ 10% trở lên. */
export function kpiStatus(actual: number, required: number | null): KpiStatus {
  if (required === null || required <= 0) return "none";
  const ratio = actual / required;
  return ratio >= 1 ? "ok" : ratio >= 0.9 ? "warn" : "bad";
}

/** Công suất đến hôm nay (trên đêm mở bán) và giá trung bình gộp (doanh thu gồm thuê giờ ÷ đêm bán). */
export function kpiActuals(a: KpiActual): { occupancyPct: number; adr: number } {
  return {
    occupancyPct: a.availableNights ? r1(Math.min(100, (a.soldNights / a.availableNights) * 100)) : 0,
    adr: a.soldNights ? Math.floor(a.revenue / a.soldNights) : 0,
  };
}

/**
 * So thực tế đến hôm nay với chỉ tiêu tháng.
 * Doanh thu cộng dồn nên mức cần đạt chia theo số ngày đã qua; công suất và giá trung bình là tỷ lệ nên so thẳng với mục tiêu.
 */
export function kpiProgress(opts: { month: Month; today: ISODate; actual: KpiActual; target: KpiTarget | null }): KpiProgress {
  const { month, today, actual, target } = opts;
  const from = firstDay(month);
  const to = lastDay(month);
  const daysInMonth = Number(to.slice(8, 10));
  const daysElapsed = today < from ? 0 : today > to ? daysInMonth : Number(today.slice(8, 10));
  const pace = daysInMonth ? daysElapsed / daysInMonth : 0;
  const { occupancyPct, adr } = kpiActuals(actual);
  const forecast = daysElapsed ? Math.round((actual.revenue / daysElapsed) * daysInMonth) : actual.revenue;
  const tRev = target && target.revenue > 0 ? target.revenue : null;
  const tOcc = target && target.occupancyPct > 0 ? target.occupancyPct : null;
  const tAdr = target && target.adr > 0 ? target.adr : null;
  return {
    daysElapsed,
    daysInMonth,
    revenue: {
      actual: actual.revenue,
      target: tRev,
      pct: tRev ? r1((actual.revenue / tRev) * 100) : null,
      pacePct: tRev ? r1(pace * 100) : null,
      status: kpiStatus(actual.revenue, tRev ? tRev * pace : null),
      forecast,
      forecastPct: tRev ? r1((forecast / tRev) * 100) : null,
    },
    occupancy: { actual: occupancyPct, target: tOcc, pct: tOcc ? r1((occupancyPct / tOcc) * 100) : null, pacePct: tOcc ? 100 : null, status: kpiStatus(occupancyPct, tOcc) },
    adr: { actual: adr, target: tAdr, pct: tAdr ? r1((adr / tAdr) * 100) : null, pacePct: tAdr ? 100 : null, status: kpiStatus(adr, tAdr) },
  };
}

/**
 * Chỉ tiêu của NĐT tự cộng từ chỉ tiêu từng cơ sở:
 * doanh thu = tổng; công suất = bình quân theo đêm mở bán của cả tháng;
 * giá TB = bình quân giá TB các cơ sở theo số đêm mục tiêu (khi 3 chỉ tiêu khớp nhau thì bằng tổng doanh thu ÷ tổng đêm mục tiêu,
 * còn khi lệch thì vẫn bám đúng giá đã nhập thay vì suy ngược từ doanh thu).
 * Cơ sở chưa có chỉ tiêu bị bỏ qua. Không cơ sở nào có chỉ tiêu thì trả null.
 */
export function aggregateTargets(items: { target: KpiTarget | null; monthAvailableNights: number }[]): KpiTarget | null {
  const withT = items.filter((i): i is { target: KpiTarget; monthAvailableNights: number } => !!i.target);
  if (!withT.length) return null;
  const revenue = withT.reduce((s, i) => s + i.target.revenue, 0);
  const avail = withT.reduce((s, i) => s + i.monthAvailableNights, 0);
  const targetNights = withT.reduce((s, i) => s + (i.target.occupancyPct / 100) * i.monthAvailableNights, 0);
  const adrWeighted = withT.reduce((s, i) => s + i.target.adr * (i.target.occupancyPct / 100) * i.monthAvailableNights, 0);
  return {
    revenue,
    occupancyPct: avail ? r1((targetNights / avail) * 100) : 0,
    adr: targetNights ? Math.round(adrWeighted / targetNights) : 0,
  };
}

/**
 * Ba chỉ tiêu ràng buộc nhau: doanh thu ≈ công suất × đêm mở bán × giá TB.
 * Trả về doanh thu suy ra và cờ lệch khi chênh quá ngưỡng (mặc định 15%). Chỉ để nhắc, không chặn lưu.
 */
export function targetConsistency(t: KpiTarget, monthAvailableNights: number, tolerance = 0.15): { implied: number; off: boolean } {
  const implied = Math.round((t.occupancyPct / 100) * monthAvailableNights * t.adr);
  if (!t.revenue || !implied) return { implied, off: false };
  return { implied, off: Math.abs(t.revenue - implied) / t.revenue > tolerance };
}

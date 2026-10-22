import { describe, expect, it } from "vitest";
import {
  BookingLite,
  NightLite,
  RoomLite,
  allocateCommonCost,
  missingExpenseCategories,
  availableNights,
  canLockMonth,
  commonCostForMonth,
  computeKpis,
  forecastProperty,
  formatVND,
  leadTimeBucket,
  lockedMonthDeltas,
  managementFee,
  payback,
  settleInvestorMonth,
  splitNights,
} from "../lib/domain";

const bk = (p: Partial<BookingLite>): BookingLite => ({
  id: "b1",
  propertyId: "X",
  roomId: "X1",
  checkIn: "2026-09-10",
  checkOut: "2026-09-11",
  netAmount: 1_000_000,
  status: "CONFIRMED",
  ...p,
});

const rooms = (pid: string, n: number, openedOn = "2026-01-01"): RoomLite[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${pid}${i + 1}`, propertyId: pid, openedOn }));

describe("5.1 Phân bổ doanh thu theo đêm", () => {
  it("đơn 1 đêm", () => {
    const n = splitNights(bk({}));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ nightDate: "2026-09-10", netAmount: 1_000_000 });
  });

  it("đơn nhiều đêm chia đều", () => {
    const n = splitNights(bk({ checkIn: "2026-09-10", checkOut: "2026-09-13", netAmount: 3_000_000 }));
    expect(n.map((x) => x.netAmount)).toEqual([1_000_000, 1_000_000, 1_000_000]);
  });

  it("đơn qua hai tháng: 30/9–03/10, net 3.000.000", () => {
    const n = splitNights(bk({ checkIn: "2026-09-30", checkOut: "2026-10-03", netAmount: 3_000_000 }));
    const sep = n.filter((x) => x.nightDate.startsWith("2026-09")).reduce((s, x) => s + x.netAmount, 0);
    const oct = n.filter((x) => x.nightDate.startsWith("2026-10")).reduce((s, x) => s + x.netAmount, 0);
    expect(sep).toBe(1_000_000);
    expect(oct).toBe(2_000_000);
  });

  it("phần dư cộng vào đêm cuối, tổng khớp net", () => {
    const n = splitNights(bk({ checkIn: "2026-09-10", checkOut: "2026-09-13", netAmount: 1_000_001 }));
    expect(n.map((x) => x.netAmount)).toEqual([333_333, 333_333, 333_335]);
    expect(n.reduce((s, x) => s + x.netAmount, 0)).toBe(1_000_001);
  });

  it("đơn hủy không phí: không có đêm", () => {
    expect(splitNights(bk({ status: "CANCELLED", netAmount: 0 }))).toEqual([]);
  });

  it("đơn hủy có phí: ghi vào ngày check-in, loại phí hủy", () => {
    const n = splitNights(bk({ status: "CANCELLED", checkOut: "2026-09-14", netAmount: 500_000 }));
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ nightDate: "2026-09-10", netAmount: 500_000, kind: "CANCEL_FEE" });
  });

  it("thuê giờ: một lượt vào ngày nhận phòng", () => {
    for (const rentalType of ["hourly_rental", "special_offer_time_rental"]) {
      const n = splitNights(bk({ rentalType, checkIn: "2026-09-10", checkOut: "2026-09-11", netAmount: 300_000 }));
      expect(n).toEqual([expect.objectContaining({ nightDate: "2026-09-10", netAmount: 300_000, kind: "HOURLY" })]);
    }
  });

  it("qua đêm ngắn và thuê theo ngày vẫn là đêm bán", () => {
    for (const rentalType of ["night_short_rental", "nightly_rental", "daily_rental", null]) {
      expect(splitNights(bk({ rentalType }))[0].kind).toBe("NIGHT");
    }
  });

  it("từ chối số thực", () => {
    expect(() => splitNights(bk({ netAmount: 1.5 }))).toThrow();
  });
});

describe("5.2 Chỉ số vận hành", () => {
  it("đêm có sẵn tính phòng mở/đóng giữa kỳ", () => {
    const r: RoomLite[] = [
      { id: "a", propertyId: "X", openedOn: "2026-09-01" },
      { id: "b", propertyId: "X", openedOn: "2026-09-16" },
      { id: "c", propertyId: "X", openedOn: "2026-01-01", closedOn: "2026-09-11" },
    ];
    // a: 30, b: 15, c: 10 (1..10)
    expect(availableNights(r, "2026-09-01", "2026-09-30")).toBe(55);
  });

  it("công suất, ADR, RevPAR", () => {
    const r = rooms("X", 2);
    const nights = splitNights(bk({ checkIn: "2026-09-01", checkOut: "2026-09-16", netAmount: 15_000_000 }));
    const k = computeKpis(nights, r, "2026-09-01", "2026-09-30");
    expect(k.soldNights).toBe(15);
    expect(k.availableNights).toBe(60);
    expect(k.occupancyPct).toBe(25);
    expect(k.adr).toBe(1_000_000);
    expect(k.revpar).toBe(250_000);
  });

  it("lượt thuê giờ và phí hủy có doanh thu nhưng không tính vào công suất", () => {
    const r = rooms("X", 1);
    const nights = [
      ...splitNights(bk({ id: "n", checkIn: "2026-09-10", checkOut: "2026-09-11", netAmount: 1_000_000 })),
      ...splitNights(bk({ id: "h", rentalType: "hourly_rental", checkIn: "2026-09-10", checkOut: "2026-09-11", netAmount: 300_000 })),
      ...splitNights(bk({ id: "c", status: "CANCELLED", checkIn: "2026-09-12", checkOut: "2026-09-13", netAmount: 200_000 })),
    ];
    const k = computeKpis(nights, r, "2026-09-01", "2026-09-30");
    expect(k.revenue).toBe(1_500_000);
    expect(k.soldNights).toBe(1);
    expect(k.hourlyCount).toBe(1);
    expect(k.adr).toBe(1_000_000);
  });

  it("nhóm lead time", () => {
    expect(leadTimeBucket("2026-09-10", "2026-09-10")).toBe("0–1");
    expect(leadTimeBucket("2026-09-10", "2026-09-05")).toBe("2–7");
    expect(leadTimeBucket("2026-09-20", "2026-09-10")).toBe("8–14");
    expect(leadTimeBucket("2026-10-10", "2026-09-10")).toBe("15–30");
    expect(leadTimeBucket("2026-12-10", "2026-09-10")).toBe(">30");
  });
});

describe("5.3 Chi phí chung", () => {
  it("chia cho số phòng lẻ, phần dư vào cơ sở nhiều phòng nhất", () => {
    const out = allocateCommonCost(10_000_000, { X: 3, Y: 4 });
    expect(out.X + out.Y).toBe(10_000_000);
    expect(out.X).toBe(4_285_714);
    expect(out.Y).toBe(5_714_286);
  });

  it("tạm tính khi chưa hoàn tất kê khai: dùng CP/phòng tháng trước", () => {
    const r = [...rooms("X", 2), ...rooms("Y", 3)];
    const c = commonCostForMonth({
      month: "2026-09",
      expenses: [{ propertyId: null, month: "2026-08", amount: 5_000_000 }],
      rooms: r,
      finalized: false,
    });
    expect(c.provisional).toBe(true);
    expect(c.perProperty).toEqual({ X: 2_000_000, Y: 3_000_000 });
  });
});

describe("5.4 Quyết toán tháng", () => {
  it("phí quản lý", () => {
    expect(managementFee(25_000_000, 20)).toBe(5_000_000);
    expect(managementFee(-5_000_000, 20)).toBe(0);
    expect(managementFee(0, 20)).toBe(0);
    expect(managementFee(1_000_003, 20)).toBe(200_000);
  });

  // Dựng dữ liệu để cơ sở X lãi 30tr, Y lỗ 5tr (không chi phí chung)
  function scenario(yLoss: number) {
    const r = [...rooms("X", 1), ...rooms("Y", 1)];
    const nights: NightLite[] = [
      ...splitNights(bk({ id: "x", propertyId: "X", roomId: "X1", checkIn: "2026-09-01", checkOut: "2026-09-11", netAmount: 40_000_000 })),
      ...splitNights(bk({ id: "y", propertyId: "Y", roomId: "Y1", checkIn: "2026-09-01", checkOut: "2026-09-02", netAmount: 1_000_000 })),
    ];
    const expenses = [
      { propertyId: "X", month: "2026-09", amount: 10_000_000 },
      { propertyId: "Y", month: "2026-09", amount: 1_000_000 + yLoss },
    ];
    return settleInvestorMonth({
      month: "2026-09",
      propertyIds: ["X", "Y"],
      rooms: r,
      nights,
      expenses,
      adjustments: [],
      commonFinalized: true,
      feePct: 20,
    });
  }

  it("NĐT hai cơ sở một lãi một lỗ (ví dụ đặc tả)", () => {
    const s = scenario(5_000_000);
    expect(s.lines.find((l) => l.propertyId === "X")!.profit).toBe(30_000_000);
    expect(s.lines.find((l) => l.propertyId === "Y")!.profit).toBe(-5_000_000);
    expect(s.totalProfit).toBe(25_000_000);
    expect(s.managementFee).toBe(5_000_000);
    expect(s.investorNet).toBe(20_000_000);
  });

  it("NĐT tổng lỗ: phí 0, NĐT nhận âm", () => {
    const s = scenario(35_000_000);
    expect(s.totalProfit).toBe(-5_000_000);
    expect(s.managementFee).toBe(0);
    expect(s.investorNet).toBe(-5_000_000);
  });

  it("NĐT một cơ sở lãi, có chi phí chung và điều chỉnh", () => {
    const r = [...rooms("X", 2), ...rooms("Z", 3)]; // Z của NĐT khác
    const nights = splitNights(bk({ propertyId: "X", roomId: "X1", checkIn: "2026-09-01", checkOut: "2026-09-21", netAmount: 20_000_000 }));
    const s = settleInvestorMonth({
      month: "2026-09",
      propertyIds: ["X"],
      rooms: r,
      nights,
      expenses: [
        { propertyId: "X", month: "2026-09", amount: 4_000_000 },
        { propertyId: null, month: "2026-09", amount: 5_000_000 },
      ],
      adjustments: [{ propertyId: "X", appliedMonth: "2026-09", amount: -1_000_000 }],
      commonFinalized: true,
      feePct: 20,
    });
    const l = s.lines[0];
    expect(l.commonCostAlloc).toBe(2_000_000);
    expect(l.revenue).toBe(19_000_000);
    expect(l.profit).toBe(13_000_000);
    expect(s.managementFee).toBe(2_600_000);
    expect(s.investorNet).toBe(10_400_000);
  });
});

describe("5.5 Khóa sổ", () => {
  it("không khóa tháng chưa kết thúc hoặc chưa kê khai chung", () => {
    expect(canLockMonth("2026-09", "2026-09-30", true).ok).toBe(false);
    expect(canLockMonth("2026-08", "2026-09-30", false).ok).toBe(false);
    expect(canLockMonth("2026-08", "2026-09-30", true).ok).toBe(true);
  });
});

describe("5.6 Điều chỉnh tháng đã khóa", () => {
  it("đơn bị hủy sau khi khóa tháng 8 sinh điều chỉnh âm", () => {
    const b = bk({ checkIn: "2026-08-30", checkOut: "2026-09-02", netAmount: 3_000_000 });
    const oldN = splitNights(b);
    const newN = splitNights({ ...b, status: "CANCELLED", netAmount: 0 });
    const d = lockedMonthDeltas(oldN, newN, new Set(["2026-08"]));
    expect(d).toEqual([{ month: "2026-08", propertyId: "X", delta: -2_000_000 }]);
  });

  it("đổi phòng cùng cơ sở, cùng tiền: không sinh điều chỉnh", () => {
    const b = bk({ checkIn: "2026-08-10", checkOut: "2026-08-12", netAmount: 2_000_000 });
    const d = lockedMonthDeltas(splitNights(b), splitNights({ ...b, roomId: "X2" }), new Set(["2026-08"]));
    expect(d).toEqual([]);
  });

  it("đổi ngày từ tháng 8 sang tháng 9", () => {
    const b = bk({ checkIn: "2026-08-10", checkOut: "2026-08-12", netAmount: 2_000_000 });
    const moved = { ...b, checkIn: "2026-09-10", checkOut: "2026-09-12" };
    const d = lockedMonthDeltas(splitNights(b), splitNights(moved), new Set(["2026-08"]));
    expect(d).toEqual([{ month: "2026-08", propertyId: "X", delta: -2_000_000 }]);
  });
});

describe("5.7 Hoàn vốn", () => {
  it("tính vốn còn lại và số tháng", () => {
    const p = payback({
      investmentTotal: 600_000_000,
      lockedNets: [
        { month: "2026-06", investorNet: 20_000_000 },
        { month: "2026-07", investorNet: 30_000_000 },
        { month: "2026-08", investorNet: 40_000_000 },
      ],
    });
    expect(p.received).toBe(90_000_000);
    expect(p.remaining).toBe(510_000_000);
    expect(p.avgLast3).toBe(30_000_000);
    expect(p.monthsLeft).toBe(17);
  });

  it("trung bình 3 tháng âm: chưa xác định", () => {
    const p = payback({
      investmentTotal: 100_000_000,
      lockedNets: [
        { month: "2026-07", investorNet: -5_000_000 },
        { month: "2026-08", investorNet: 2_000_000 },
      ],
    });
    expect(p.monthsLeft).toBeNull();
  });

  it("bỏ qua tháng trước investmentStartMonth", () => {
    const p = payback({
      investmentTotal: 100_000_000,
      lockedNets: [
        { month: "2026-01", investorNet: 50_000_000 },
        { month: "2026-08", investorNet: 10_000_000 },
      ],
      startMonth: "2026-03",
    });
    expect(p.received).toBe(10_000_000);
  });
});

describe("5.8 Dự kiến", () => {
  const r = rooms("X", 2);
  // Tháng 8: 31 đêm bán / 62 có sẵn → công suất 50%
  const aug = splitNights(bk({ id: "a", checkIn: "2026-08-01", checkOut: "2026-09-01", netAmount: 31_000_000 }));

  function f(today: string, sep: NightLite[]) {
    return forecastProperty({
      month: "2026-09",
      today,
      rooms: r,
      nights: [...aug, ...sep],
      fixedCostMonthly: 10_000_000,
      variableCostPerNight: 100_000,
      commonCost: 1_000_000,
    });
  }

  it("ngày 1: dự kiến = doanh thu ngày 1 × 30", () => {
    const sep = splitNights(bk({ id: "s", checkIn: "2026-09-01", checkOut: "2026-09-02", netAmount: 500_000 }));
    const x = f("2026-09-01", sep);
    expect(x.revenuePast).toBe(500_000);
    expect(x.emptyRemaining).toBe(58);
    expect(x.revenueForecast).toBe(15_000_000);
    expect(x.costForecast).toBe(10_000_000 + 30 * 100_000 + 1_000_000);
  });

  it("tháng chưa tới: dùng doanh thu các đêm đã đặt", () => {
    const sep = splitNights(bk({ id: "s", checkIn: "2026-09-05", checkOut: "2026-09-07", netAmount: 2_000_000 }));
    const x = f("2026-08-20", sep);
    expect(x.revenuePast).toBe(0);
    expect(x.revenueForecast).toBe(2_000_000);
  });

  it("giữa tháng: đêm hôm nay đã tính vào doanh thu (Quy chế, Điều 1)", () => {
    const sep = splitNights(bk({ id: "s", checkIn: "2026-09-01", checkOut: "2026-09-21", netAmount: 24_000_000 }));
    const x = f("2026-09-16", sep);
    expect(x.soldPast).toBe(16);
    expect(x.revenuePast).toBe(16 * 1_200_000);
    expect(x.bookedFuture).toBe(4);
    expect(x.emptyRemaining).toBe(28 - 4);
    expect(x.adrUsed).toBe(1_200_000);
    // Doanh thu đến hôm nay ÷ 16 ngày (gồm hôm nay) × 30 ngày
    expect(x.revenueForecast).toBe(Math.round((16 * 1_200_000) / 16 * 30));
  });

  it("khách nhận phòng hôm nay: đêm nay có trong doanh thu đến hôm nay", () => {
    const sep = splitNights(bk({ id: "s", checkIn: "2026-09-16", checkOut: "2026-09-18", netAmount: 2_000_000 }));
    const x = f("2026-09-16", sep);
    expect(x.revenuePast).toBe(1_000_000);
    expect(x.soldPast).toBe(1);
    expect(x.bookedFuture).toBe(1);
  });

  it("thuê giờ hôm nay: có doanh thu, không tính đêm bán", () => {
    const sep = splitNights(bk({ id: "h", rentalType: "hourly_rental", checkIn: "2026-09-16", checkOut: "2026-09-17", netAmount: 300_000 }));
    const x = f("2026-09-16", sep);
    expect(x.revenuePast).toBe(300_000);
    expect(x.soldPast).toBe(0);
    expect(x.hourlyPast).toBe(1);
  });

  it("cuối tháng", () => {
    const sep = splitNights(bk({ id: "s", checkIn: "2026-09-01", checkOut: "2026-09-30", netAmount: 29_000_000 }));
    const x = f("2026-09-30", sep);
    expect(x.bookedFuture).toBe(0);
    expect(x.emptyRemaining).toBe(0);
    expect(x.revenuePast).toBe(29_000_000);
    expect(x.revenueForecast).toBe(29_000_000);
  });

  it("ví dụ ngày 22/10: 41.170.320 ÷ 22 × 31", () => {
    const oct = splitNights(bk({ id: "o", checkIn: "2026-10-01", checkOut: "2026-10-23", netAmount: 41_170_320 }));
    const x = forecastProperty({ month: "2026-10", today: "2026-10-22", rooms: r, nights: oct, fixedCostMonthly: 0, variableCostPerNight: 0, commonCost: 0 });
    expect(x.revenuePast).toBe(41_170_320);
    expect(x.revenueForecast).toBe(58_012_724);
  });
});

describe("Định dạng", () => {
  it("tiền VND", () => {
    expect(formatVND(1_250_000)).toBe("1.250.000 ₫");
    expect(formatVND(-5_000_000)).toBe("−5.000.000 ₫");
  });
});

describe("Cảnh báo thiếu chi phí tháng", () => {
  const categoryName = { c1: "Thuê nhà", c2: "Internet", c3: "Vật tư tiêu hao", c4: "Lương", c5: "Bảo trì", c6: "Điện nước" };
  const all = (pid: string | null) => ["c1", "c2", "c3", "c5", "c6"].map((categoryId) => ({ propertyId: pid, categoryId, approvalStatus: "APPROVED" }));

  it("liệt kê đúng loại còn thiếu theo cơ sở; lương kê khai chung tính cho mọi cơ sở", () => {
    const expenses = [...all("A"), { propertyId: null, categoryId: "c4", approvalStatus: "PENDING" }, { propertyId: "B", categoryId: "c1", approvalStatus: "APPROVED" }];
    expect(missingExpenseCategories({ propertyIds: ["A", "B"], expenses, categoryName })).toEqual([
      { propertyId: "B", missing: ["Internet", "Vật tư tiêu hao", "Bảo trì", "Điện nước"] },
    ]);
  });

  it("khoản bị từ chối coi như chưa có; chưa có khoản nào thì thiếu đủ 6 loại", () => {
    const expenses = [{ propertyId: "A", categoryId: "c1", approvalStatus: "REJECTED" }];
    expect(missingExpenseCategories({ propertyIds: ["A"], expenses, categoryName })[0].missing).toEqual(["Thuê nhà", "Internet", "Vật tư tiêu hao", "Lương", "Bảo trì", "Điện nước"]);
  });
});

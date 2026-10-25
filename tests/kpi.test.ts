import { describe, expect, it } from "vitest";
import { aggregateTargets, costForecastWithActual, kpiActuals, kpiProgress, kpiStatus, targetConsistency } from "../lib/domain";

describe("chi phí dự kiến không thấp hơn chi phí đã chi", () => {
  it("số trên trang Tổng quan 25/10/2026: mô hình 25,7tr nhưng đã chi 409,2tr → dùng 409,2tr", () => {
    expect(costForecastWithActual(25_669_490, 409_231_774)).toBe(409_231_774);
  });
  it("chưa nhập đủ chi phí thì giữ mức của mô hình", () => {
    expect(costForecastWithActual(30_000_000, 12_000_000)).toBe(30_000_000);
  });
});

describe("chỉ số thực tế đến hôm nay", () => {
  it("công suất trên đêm mở bán đến hôm nay, giá TB gộp cả thuê giờ", () => {
    // 2.195 đêm bán / 2.250 đêm mở bán (90 phòng × 25 ngày); doanh thu 925,3tr gồm thuê giờ
    expect(kpiActuals({ revenue: 925_291_806, soldNights: 2195, availableNights: 2250 })).toEqual({ occupancyPct: 97.6, adr: 421_545 });
  });
  it("không có đêm mở bán hay đêm bán thì bằng 0, không chia cho 0", () => {
    expect(kpiActuals({ revenue: 5_000_000, soldNights: 0, availableNights: 0 })).toEqual({ occupancyPct: 0, adr: 0 });
  });
});

describe("tiến độ KPI tháng", () => {
  const actual = { revenue: 925_291_806, soldNights: 2195, availableNights: 2250 };

  it("doanh thu so với mục tiêu chia theo số ngày đã qua; dự kiến = DT đến nay ÷ ngày đã qua × ngày của tháng", () => {
    const p = kpiProgress({ month: "2026-10", today: "2026-10-25", actual, target: { revenue: 1_100_000_000, occupancyPct: 85, adr: 450_000 } });
    expect(p.daysElapsed).toBe(25);
    expect(p.revenue.pct).toBe(84.1);
    expect(p.revenue.pacePct).toBe(80.6);
    expect(p.revenue.status).toBe("ok"); // 84,1% đã vượt mức cần 80,6%
    expect(p.revenue.forecast).toBe(1_147_361_839);
    expect(p.revenue.forecastPct).toBe(104.3);
  });

  it("công suất và giá TB so thẳng với mục tiêu", () => {
    const p = kpiProgress({ month: "2026-10", today: "2026-10-25", actual, target: { revenue: 1_100_000_000, occupancyPct: 85, adr: 450_000 } });
    expect(p.occupancy).toMatchObject({ actual: 97.6, target: 85, status: "ok", pacePct: 100 });
    expect(p.adr).toMatchObject({ actual: 421_545, target: 450_000, pct: 93.7, status: "warn" });
  });

  it("chưa có chỉ tiêu thì không xếp màu", () => {
    const p = kpiProgress({ month: "2026-10", today: "2026-10-25", actual, target: null });
    expect(p.revenue.status).toBe("none");
    expect(p.revenue.pct).toBeNull();
    expect(p.occupancy.status).toBe("none");
  });

  it("ngưỡng màu: đạt xanh, thiếu dưới 10% vàng, thiếu từ 10% đỏ", () => {
    expect(kpiStatus(100, 100)).toBe("ok");
    expect(kpiStatus(91, 100)).toBe("warn");
    expect(kpiStatus(90, 100)).toBe("warn");
    expect(kpiStatus(89.9, 100)).toBe("bad");
    expect(kpiStatus(50, null)).toBe("none");
  });
});

describe("chỉ tiêu NĐT tự cộng từ cơ sở", () => {
  it("doanh thu cộng; công suất bình quân theo đêm mở bán; giá TB bình quân theo đêm mục tiêu", () => {
    const t = aggregateTargets([
      { target: { revenue: 180_000_000, occupancyPct: 88, adr: 450_000 }, monthAvailableNights: 155 },
      { target: { revenue: 230_000_000, occupancyPct: 80, adr: 470_000 }, monthAvailableNights: 310 },
      { target: null, monthAvailableNights: 100 }, // chưa nhập: bỏ qua
    ]);
    // đêm mục tiêu = 136,4 + 248 = 384,4 trên 465 đêm mở bán; giá = (450k × 136,4 + 470k × 248) ÷ 384,4
    expect(t).toEqual({ revenue: 410_000_000, occupancyPct: 82.7, adr: 462_903 });
  });
  it("một cơ sở thì giá TB của NĐT bằng đúng giá đã nhập, kể cả khi doanh thu nhập hơi lệch", () => {
    // Ca thật trên màn nhập: 92 tr, 85%, 460k, 217 đêm mở bán; trước đây ra 498.780 đ vì chia ngược từ doanh thu
    expect(aggregateTargets([{ target: { revenue: 92_000_000, occupancyPct: 85, adr: 460_000 }, monthAvailableNights: 217 }])?.adr).toBe(460_000);
  });
  it("3 chỉ tiêu khớp nhau thì giá TB bằng tổng doanh thu ÷ tổng đêm mục tiêu", () => {
    const t = aggregateTargets([
      { target: { revenue: 0.8 * 100 * 400_000, occupancyPct: 80, adr: 400_000 }, monthAvailableNights: 100 },
      { target: { revenue: 0.9 * 200 * 500_000, occupancyPct: 90, adr: 500_000 }, monthAvailableNights: 200 },
    ])!;
    expect(t.adr).toBe(Math.round(t.revenue / (80 + 180)));
  });
  it("không cơ sở nào có chỉ tiêu thì trả null", () => {
    expect(aggregateTargets([{ target: null, monthAvailableNights: 100 }])).toBeNull();
  });
});

describe("cảnh báo 3 chỉ tiêu không khớp nhau", () => {
  it("doanh thu ≈ công suất × đêm mở bán × giá TB thì không cảnh báo", () => {
    expect(targetConsistency({ revenue: 61_000_000, occupancyPct: 88, adr: 450_000 }, 155)).toEqual({ implied: 61_380_000, off: false });
  });
  it("lệch quá 15% thì cảnh báo", () => {
    expect(targetConsistency({ revenue: 180_000_000, occupancyPct: 88, adr: 450_000 }, 155)).toEqual({ implied: 61_380_000, off: true });
  });
});

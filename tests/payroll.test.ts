// Lương buồng phòng: chấm công theo ca (bắt buộc ảnh), công chuẩn = ngày trong tháng − ngày nghỉ,
// tăng ca theo lần, thưởng/phạt theo đánh giá của cơ sở được giao, ảnh chấm công chỉ người được phép xem.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { calcPay, monthlyPayroll, savePayrollRates, setHousekeeperPay, addPayrollAdjustment } from "../lib/services/payroll";
import { clockIn, clockOut } from "../lib/services/tasks";
import { canViewPhoto } from "../lib/services/photos";
import * as D from "../lib/domain";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const hk1: SessionUser = { id: "u-hk1", name: "Chị Lan", role: "HOUSEKEEPER" };
const hk2: SessionUser = { id: "u-hk2", name: "Chị Mai", role: "HOUSEKEEPER" };
const rates = { daysOff: 2, overtimeRate: 31000, fiveStarBonus: 10000, lowReviewPenalty: 50000 };

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.users).values([
    { id: admin.id, name: admin.name, role: "ADMIN", passwordHash: "x" },
    { id: hk1.id, name: hk1.name, role: "HOUSEKEEPER", passwordHash: "x" },
    { id: hk2.id, name: hk2.name, role: "HOUSEKEEPER", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values({ id: "inv", name: "NĐT" });
  await db.insert(s.properties).values([{ id: "VP", investorId: "inv", name: "Vạn Phúc" }, { id: "KT", investorId: "inv", name: "Khương Trung" }]);
  await db.insert(s.userPropertyAccess).values([{ userId: hk1.id, propertyId: "VP" }, { userId: hk2.id, propertyId: "KT" }]);
  // Tháng 11/2026 có 30 ngày → công chuẩn 28
  await db.insert(s.attendance).values([
    { userId: hk1.id, propertyId: "VP", date: "2026-11-01", shift: "MORNING", checkInAt: new Date("2026-11-01T01:00:00Z") },
    { userId: hk1.id, propertyId: "VP", date: "2026-11-02", shift: "MORNING", checkInAt: new Date("2026-11-02T01:00:00Z") },
    { userId: hk1.id, propertyId: "VP", date: "2026-11-02", shift: "EVENING", checkInAt: new Date("2026-11-02T11:00:00Z") },
    { userId: hk1.id, propertyId: "VP", date: "2026-11-02", shift: "OVERTIME", checkInAt: new Date("2026-11-02T14:00:00Z") },
    { userId: hk2.id, propertyId: "KT", date: "2026-11-01", shift: "EVENING", checkInAt: new Date("2026-11-01T11:00:00Z") },
    // Tháng trước: không tính
    { userId: hk1.id, propertyId: "VP", date: "2026-10-31", shift: "MORNING", checkInAt: new Date("2026-10-31T01:00:00Z") },
  ]);
  await db.insert(s.reviews).values([
    { propertyId: "VP", channel: "Airbnb", score: "5", reviewDate: "2026-11-03" },
    { propertyId: "VP", channel: "Airbnb", score: "5", reviewDate: "2026-11-04" },
    { propertyId: "VP", channel: "Airbnb", score: "3.5", reviewDate: "2026-11-05" },
    { propertyId: "VP", channel: "Airbnb", score: "4.5", reviewDate: "2026-11-06" }, // không thưởng không phạt
    { propertyId: "KT", channel: "Airbnb", score: "2", reviewDate: "2026-11-07" },
    { propertyId: "VP", channel: "Airbnb", score: "5", reviewDate: "2026-10-30" }, // tháng trước
  ]);
});

describe("tính lương", () => {
  it("đơn giá công = lương tháng ÷ (ngày trong tháng − ngày nghỉ)", () => {
    const l = calcPay("2026-11", rates, { morningMonthly: 5_600_000, eveningMonthly: 2_800_000, morningShifts: 28, eveningShifts: 3, overtime: 2, fiveStar: 4, low: 1, adjustments: -100_000 });
    expect(l.standardDays).toBe(28);
    expect(l.morningRate).toBe(200_000);
    expect(l.morningPay).toBe(5_600_000);
    expect(l.eveningPay).toBe(300_000);
    expect(l.overtimePay).toBe(62_000);
    expect(l.bonus).toBe(40_000);
    expect(l.penalty).toBe(50_000);
    expect(l.total).toBe(5_600_000 + 300_000 + 62_000 + 40_000 - 50_000 - 100_000);
  });

  it("tháng 31 ngày công chuẩn 29, tháng 2 công chuẩn 26", () => {
    expect(calcPay("2026-12", rates, { morningMonthly: 2_900_000, eveningMonthly: 0, morningShifts: 1, eveningShifts: 0, overtime: 0, fiveStar: 0, low: 0, adjustments: 0 }).morningRate).toBe(100_000);
    expect(calcPay("2026-02", rates, { morningMonthly: 2_600_000, eveningMonthly: 0, morningShifts: 1, eveningShifts: 0, overtime: 0, fiveStar: 0, low: 0, adjustments: 0 }).morningRate).toBe(100_000);
  });

  it("bảng lương tháng: đếm ca theo tháng, đánh giá theo cơ sở được giao", async () => {
    await setHousekeeperPay(db, admin, hk1.id, 5_600_000, 2_800_000);
    await addPayrollAdjustment(db, admin, hk1.id, "2026-11", -200_000, "Ứng lương");
    const p = await monthlyPayroll(db, admin, "2026-11");
    const lan = p.rows.find((r) => r.userId === hk1.id)!;
    expect([lan.morningShifts, lan.eveningShifts, lan.overtime, lan.fiveStar, lan.low]).toEqual([2, 1, 1, 2, 1]);
    expect(lan.total).toBe(400_000 + 100_000 + 31_000 + 20_000 - 50_000 - 200_000);
    const mai = p.rows.find((r) => r.userId === hk2.id)!;
    expect([mai.eveningShifts, mai.fiveStar, mai.low, mai.total]).toEqual([1, 0, 1, -50_000]);
  });

  it("đổi cài đặt áp dụng ngay; chỉ admin xem và sửa", async () => {
    await savePayrollRates(db, admin, { ...rates, overtimeRate: 40_000 });
    expect((await monthlyPayroll(db, admin, "2026-11")).rows.find((r) => r.userId === hk1.id)!.overtimePay).toBe(40_000);
    await savePayrollRates(db, admin, rates);
    await expect(monthlyPayroll(db, hk1, "2026-11")).rejects.toThrow();
    await expect(setHousekeeperPay(db, hk1, hk1.id, 9e9, 0)).rejects.toThrow();
  });
});

describe("chấm công theo ca", () => {
  it("buồng phòng phải có ảnh; mỗi ca mỗi ngày một lần; chỉ cơ sở được giao", async () => {
    await expect(clockIn(db, hk2, { propertyId: "KT", shift: "MORNING" })).rejects.toThrow(/Chụp ảnh/);
    await expect(clockIn(db, hk2, { propertyId: "VP", shift: "MORNING", photoUrl: "loci-photos/attendance/x.jpg" })).rejects.toThrow();
    const row = await clockIn(db, hk2, { propertyId: "KT", shift: "MORNING", photoUrl: "loci-photos/attendance/a.jpg", lat: 21.0012, lng: 105.8201, accuracyM: 12.4 });
    expect(row).toMatchObject({ shift: "MORNING", date: D.todayVN(), lat: 21.0012, lng: 105.8201, accuracyM: 12 });
    await expect(clockIn(db, hk2, { propertyId: "KT", shift: "MORNING", photoUrl: "loci-photos/attendance/b.jpg" })).rejects.toThrow(/đã vào ca/);
    await clockIn(db, hk2, { propertyId: "KT", shift: "OVERTIME", photoUrl: "loci-photos/attendance/c.jpg" });
    await clockOut(db, hk2);
    await clockOut(db, hk2);
    await expect(clockOut(db, hk2)).rejects.toThrow(/Không có ca/);
  });

  it("ảnh chấm công: chính chủ và admin xem được, người khác thì không", async () => {
    expect(await canViewPhoto(db, hk2, "loci-photos/attendance/a.jpg")).toBe(true);
    expect(await canViewPhoto(db, admin, "loci-photos/attendance/a.jpg")).toBe(true);
    expect(await canViewPhoto(db, hk1, "loci-photos/attendance/a.jpg")).toBe(false);
  });
});

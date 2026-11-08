// Nhập file chi phí theo mẫu bảng tổng hợp: đọc cột, quy tháng, khớp cơ sở/loại, báo trùng, kê khai chờ duyệt.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { readXlsxGrids, type Cell } from "../lib/bank/statement-parser";
import { allocationNote, buildDescription, monthLabel, splitAmount, parseExpenseGrid, parseSheetMonth, splitDescription } from "../lib/expenses/sheet";
import { commitExpenseImport, previewExpenseImport } from "../lib/services/expense-import";
import { createSplitExpense } from "../lib/services/expenses";

// Giống ảnh bảng tổng hợp chi phí tháng 10 của kế toán
const HEAD: Cell[] = ["Ngày", "Khoản chi", "Nhóm chi phí", "Cơ sở", "Người nhận", "Số tiền", "Ghi chú", "Thuộc tháng"];
const GRID: Cell[][] = [
  HEAD,
  ["03/10/2026", "Lương dọn dẹp - Phạm Hoài Đức", "Lương", "26 Đỗ Quang", "PHAM HOAI DUC", "9,821,429", "Bảng lương ghi tháng 9", "T9"],
  ["04/10/2026", "Tiền điện", "Điện nước", "26 Đỗ Quang", "EVN Hà Nội", 11470291, "Thanh toán hoá đơn", "T9"],
  [new Date("2026-10-13T00:00:00Z"), "Dầu ăn", "Vật tư", "26 Đỗ Quang", "LO THI TAM", 279000, "", "T10"],
  ["27/10/2026", "Netflix tháng 11", "Internet/Netflix", "26 Đỗ Quang", "NGUYEN TIEN TOAN", 273000, "", "T11"],
  [],
  ["", "", "", "", "", "", "", ""],
  ["Tổng", "", "", "", "", 21843720],
];

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };
const inv: SessionUser = { id: "u-inv", name: "NĐT", role: "INVESTOR" };

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
    { id: acc.id, name: acc.name, role: "ACCOUNTANT", passwordHash: "x" },
    { id: inv.id, name: inv.name, role: "INVESTOR", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([{ id: "inv-a", name: "NĐT A", userId: inv.id }]);
  await db.insert(s.properties).values([
    { id: "DQ", investorId: "inv-a", name: "26 Đỗ Quang", bankCodes: ["dq"] },
    { id: "VP", investorId: "inv-a", name: "Vạn Phúc", bankCodes: ["vp"] },
  ]);
  await db.insert(s.userPropertyAccess).values([{ userId: acc.id, propertyId: "DQ" }, { userId: acc.id, propertyId: "VP" }]);
  await db.insert(s.expenseCategories).values([
    { id: "luong", name: "Lương", scope: "DIRECT" },
    { id: "dn", name: "Điện nước", scope: "DIRECT" },
    { id: "vt", name: "Vật tư", scope: "DIRECT" },
  ]);
});

describe("Đọc file theo cột mẫu", () => {
  it("nhận cột theo tiêu đề, bỏ dòng trống và dòng tổng", () => {
    const rows = parseExpenseGrid([["Bảng chi phí tháng 10"], [], ...GRID]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ line: 4, incurredOn: "2026-10-03", item: "Lương dọn dẹp - Phạm Hoài Đức", category: "Lương", property: "26 Đỗ Quang", amount: 9821429, fileMonth: "2026-09", errors: [] });
    expect(rows[2]).toMatchObject({ incurredOn: "2026-10-13", amount: 279000, fileMonth: "2026-10" });
    expect(rows[3].fileMonth).toBe("2026-11");
  });

  it("cột đổi chỗ vẫn đọc đúng; thiếu cột bắt buộc thì báo", () => {
    const rows = parseExpenseGrid([["Số tiền", "Cơ sở", "Ngày", "Nhóm chi phí", "Khoản chi"], [100000, "Vạn Phúc", "01/11/2026", "Vật tư", "Khăn"]]);
    expect(rows[0]).toMatchObject({ amount: 100000, property: "Vạn Phúc", incurredOn: "2026-11-01", item: "Khăn", fileMonth: null });
    expect(() => parseExpenseGrid([["Ngày", "Khoản chi"], ["01/11/2026", "x"]])).toThrow(/Nhóm chi phí/);
  });

  it("lỗi từng dòng nằm trong row.errors", () => {
    const [r] = parseExpenseGrid([HEAD, ["32/13/2026", "", "Vật tư", "Vạn Phúc", "", "0", "", "Tháng mười"]]);
    expect(r.errors.join(" | ")).toMatch(/Ngày.*Khoản chi.*Số tiền.*Thuộc tháng/);
  });

  it("Thuộc tháng: lấy năm gần ngày chi nhất", () => {
    expect(parseSheetMonth("T12", "2027-01-02")).toBe("2026-12");
    expect(parseSheetMonth("t1", "2026-12-28")).toBe("2027-01");
    expect(parseSheetMonth("Tháng 9", "2026-10-03")).toBe("2026-09");
    expect(parseSheetMonth("10/2026", null)).toBe("2026-10");
    expect(parseSheetMonth("13", "2026-10-03")).toBeNull();
    expect(monthLabel("2026-09", "2026-10-03")).toBe("T9");
    expect(monthLabel("2027-01", "2026-12-28")).toBe("T1/2027");
  });

  it("mô tả ghép rồi tách lại đúng 3 cột", () => {
    const d = buildDescription({ item: "Tiền điện", recipient: "EVN Hà Nội", note: "Thanh toán hoá đơn" });
    expect(d).toBe("Tiền điện · Người nhận: EVN Hà Nội · Ghi chú: Thanh toán hoá đơn");
    expect(splitDescription(d)).toEqual({ item: "Tiền điện", recipient: "EVN Hà Nội", note: "Thanh toán hoá đơn" });
    expect(splitDescription("Nước giặt")).toEqual({ item: "Nước giặt", recipient: "", note: "" });
    expect(splitDescription(buildDescription({ item: "Cờ", note: "Không VAT" }))).toEqual({ item: "Cờ", recipient: "", note: "Không VAT" });
  });

  it("đọc được file .xlsx thật", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("T10");
    for (const r of GRID) ws.addRow(r);
    const [grid] = await readXlsxGrids((await wb.xlsx.writeBuffer()) as ArrayBuffer, "lỗi");
    expect(parseExpenseGrid(grid).map((r) => r.amount)).toEqual([9821429, 11470291, 279000, 273000]);
  });
});

describe("Xem trước và kê khai", () => {
  it("mặc định hạch toán theo tháng chi; loại chưa có đánh dấu tạo mới", async () => {
    const p = await previewExpenseImport(db, acc, parseExpenseGrid(GRID), "paid");
    expect(p.map((r) => r.month)).toEqual(["2026-10", "2026-10", "2026-10", "2026-10"]);
    expect(p[0]).toMatchObject({ propertyId: "DQ", categoryId: "luong", newCategory: false, errors: [] });
    expect(p[0].warnings[0]).toMatch(/T9/);
    expect(p[3]).toMatchObject({ categoryId: null, categoryName: "Internet/Netflix", newCategory: true });
  });

  it("theo cột Thuộc tháng khi chọn", async () => {
    const p = await previewExpenseImport(db, acc, parseExpenseGrid(GRID), "file");
    expect(p.map((r) => r.month)).toEqual(["2026-09", "2026-09", "2026-10", "2026-11"]);
  });

  it("cơ sở không có / chi phí chung", async () => {
    const p = await previewExpenseImport(db, acc, parseExpenseGrid([HEAD,
      ["01/11/2026", "x", "Vật tư", "Lạc Trung", "", 1000, "", ""],
      ["01/11/2026", "BHXH", "Lương", "Chi phí chung", "", 2000, "", ""],
      ["01/11/2026", "y", "Vật tư", "vp", "", 3000, "", ""],
    ]), "paid");
    expect(p[0].errors[0]).toMatch(/Không tìm thấy cơ sở/);
    expect(p[1].propertyId).toBeNull();
    expect(p[2].propertyId).toBe("VP");
  });

  it("NĐT không nhập được", async () => {
    await expect(previewExpenseImport(db, inv, [], "paid")).rejects.toMatchObject({ status: 403 });
  });

  it("kê khai: chờ duyệt, tạo loại mới; tải lại cùng file báo trùng", async () => {
    const p = await previewExpenseImport(db, acc, parseExpenseGrid(GRID), "paid");
    const res = await commitExpenseImport(db, acc, p.map((r) => ({
      line: r.line, propertyId: r.propertyId ?? null, categoryId: r.categoryId, categoryName: r.categoryName, months: [r.month], incurredOn: r.incurredOn, amount: r.amount, description: r.description,
    })));
    expect(res.errors).toEqual([]);
    expect(res.created).toHaveLength(4);
    const rows = await db.select().from(schema.expenses).where(eq(schema.expenses.propertyId, "DQ"));
    expect(rows.every((e) => e.approvalStatus === "PENDING" && e.month === "2026-10")).toBe(true);
    expect(rows.find((e) => e.amount === 11470291)?.description).toBe("Tiền điện · Người nhận: EVN Hà Nội · Ghi chú: Thanh toán hoá đơn");
    const cats = await db.select().from(schema.expenseCategories);
    expect(cats.some((c) => c.name === "Internet/Netflix")).toBe(true);

    const again = await previewExpenseImport(db, acc, parseExpenseGrid(GRID), "paid");
    expect(again.every((r) => r.duplicateOf)).toBe(true);
    expect(again[3]).toMatchObject({ newCategory: false });
  });
});

describe("Phân bổ nhiều tháng hạch toán", () => {
  it("chia đều, phần lẻ dồn tháng đầu; mô tả giữ Người nhận / Ghi chú tách được", () => {
    expect(splitAmount(1_000_000, 3)).toEqual([333_334, 333_333, 333_333]);
    expect(splitAmount(900_000, 3)).toEqual([300_000, 300_000, 300_000]);
    const d = allocationNote(buildDescription({ item: "Wifi", recipient: "Viettel", note: "Trả trước" }), 2, 3, 900_000);
    expect(splitDescription(d)).toEqual({ item: "Wifi (phân bổ 2/3 của 900.000 ₫)", recipient: "Viettel", note: "Trả trước" });
  });

  it("kê khai tay 3 tháng → 3 khoản, tổng đúng bằng số tiền", async () => {
    const rows = await createSplitExpense(db, acc, { propertyId: "VP", categoryId: "dn", incurredOn: "2026-11-02", amount: 1_000_000, description: "Wifi 3 tháng" }, ["2026-12", "2026-11", "2027-01"]);
    expect(rows.map((e) => [e.month, e.amount])).toEqual([["2026-11", 333_334], ["2026-12", 333_333], ["2027-01", 333_333]]);
    expect(rows.every((e) => e.approvalStatus === "PENDING" && e.propertyId === "VP")).toBe(true);
    expect(rows[0].description).toBe("Wifi 3 tháng (phân bổ 1/3 của 1.000.000 ₫)");
  });

  it("một tháng giữ nguyên mô tả; tháng trùng hoặc trống thì báo lỗi", async () => {
    const [e] = await createSplitExpense(db, acc, { propertyId: "VP", categoryId: "dn", incurredOn: "2026-11-02", amount: 50_000, description: "Ga" }, ["2026-11"]);
    expect(e.description).toBe("Ga");
    await expect(createSplitExpense(db, acc, { propertyId: "VP", categoryId: "dn", incurredOn: "2026-11-02", amount: 50_000, description: "x" }, ["2026-11", "2026-11"])).rejects.toThrow(/trùng/);
    await expect(createSplitExpense(db, acc, { propertyId: "VP", categoryId: "dn", incurredOn: "2026-11-02", amount: 50_000, description: "x" }, [])).rejects.toThrow(/Chọn tháng/);
  });

  it("một tháng đã khóa sổ thì không tạo tháng nào", async () => {
    await db.insert(schema.settlements).values({ investorId: "inv-a", month: "2026-08", status: "LOCKED" } as never);
    const before = (await db.select().from(schema.expenses)).length;
    await expect(createSplitExpense(db, acc, { propertyId: "VP", categoryId: "dn", incurredOn: "2026-08-02", amount: 300_000, description: "Bảo trì" }, ["2026-08", "2026-09", "2026-10"])).rejects.toThrow(/khóa sổ/);
    expect((await db.select().from(schema.expenses)).length).toBe(before);
  });

  it("nhập file: một dòng chọn 3 tháng → 3 khoản", async () => {
    const res = await commitExpenseImport(db, acc, [{ line: 9, propertyId: "DQ", categoryId: "vt", categoryName: "Vật tư", months: ["2026-11", "2026-12", "2027-01"], incurredOn: "2026-11-05", amount: 3_000_000, description: buildDescription({ item: "Amenities quý", recipient: "CTY VU XUAN PHUONG" }) }]);
    expect(res.errors).toEqual([]);
    expect(res.created).toHaveLength(3);
  });
});

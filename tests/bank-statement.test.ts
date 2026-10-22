// Đọc sao kê và gợi ý phân loại (hàm thuần). Dữ liệu mẫu theo đúng bố cục file MB Bank, số liệu bịa.
import { describe, expect, it } from "vitest";
import { parseAmount, parseStatementGrid, parseVnDateTime, type Cell } from "../lib/bank/statement-parser";
import { classifyTransaction, cleanDescription, guessMonth } from "../lib/bank/classify";

const grid: Cell[][] = [
  [null, null, "SAO KÊ CHI TIẾT TÀI KHOẢN\nAccount Statement", null, null, null, null, "NGÂN HÀNG TMCP QUÂN ĐỘI\nMilitary Commercial Joint Stock Bank", null],
  [null, null, "Từ ngày/From:16/09/2026 00:00:00 Đến ngày/To:16/10/2026 23:59:59", null, null, null, null, " Chi nhánh/Branch: VN0010006", null],
  [],
  ["Tên khách hàng/Customer name: CONG TY TNHH MAU\n\nMã khách hàng/Customer code: 12345678", null, null, null, null, null, null, "Tài khoản/Account No: 1234567890\n\nLoại tiền/Currency: VND", null],
  [],
  ["\nChúng tôi xin thông báo chi tiết phát sinh nợ/có...\n\nSố dư đầu kỳ/ Opening Balance: 1,000,000 VND\n"],
  ["STT", "NGÀY GIAO DỊCH", "NGÀY HẠCH TOÁN", "PHÁT SINH NỢ", "PHÁT SINH CÓ", "SỐ DƯ", "ĐƠN VỊ THỤ HƯỞNG/ĐƠN VỊ CHUYỂN", "NỘI DUNG", "BÚT TOÁN"],
  ["1", "15/10/2026 11:07:44", "15/10/2026", 403000, 0, 597000, "LO THI A", "MBCT khd vtp nuoc giat DL29XJJA/955  391 ", "FT001"],
  ["2", "14/10/2026 07:06:11", "14/10/2026", "273,000", 0, 324000, "NGUYEN VAN B", "khd-kt-ntg-dk may chieu ", "FT002"],
  ["3", "10/10/2026 16:39:41", "10/10/2026", 0, 500000, 824000, "CONG TY MAU", "Chuyen khoan van hanh", "FT003"],
  ["4", "04/10/2026 10:52:48", "05/10/2026", 120000, 0, 704000, "BUI C", "vtp-luong don dep t9 ", "FT004"],
  ["5", "06/10/2026 09:20:10", "06/10/2026", 100000, 0, 604000, "TRAN D", "coso- luong nhan vien t9 ", "FT005"],
  ["6", "08/10/2026 17:11:20", "08/10/2026", 4000, 0, 600000, "CONG TY VNPAY", "VNPAY BILL ELECTRIC 1446341185 aWyI  f17B2EY.BP1  HN02-1446341185", "FT006"],
  [null, null, "TỔNG TIỀN", 900000, 500000, null, null, null, null],
  ["Số dư cuối kỳ/ Closing Balance: 600,000 VND"],
];

describe("Đọc sao kê MB", () => {
  const p = parseStatementGrid(grid);
  it("đọc phần đầu: tài khoản, kỳ, số dư", () => {
    expect(p).toMatchObject({ bank: "MB", accountNo: "1234567890", accountName: "CONG TY TNHH MAU", fromDate: "2026-09-16", toDate: "2026-10-16", openingBalance: 1_000_000, closingBalance: 600_000 });
  });
  it("đọc đủ dòng, khớp dòng TỔNG TIỀN", () => {
    expect(p.rows).toHaveLength(6);
    expect(p.totalDebit).toBe(900_000);
    expect(p.totalCredit).toBe(500_000);
    expect(p.warnings).toEqual([]);
    expect(p.rows[1]).toMatchObject({ ref: "FT002", debit: 273_000, credit: 0, bookedOn: "2026-10-14", counterparty: "NGUYEN VAN B" });
    expect(p.rows[3].bookedOn).toBe("2026-10-05"); // ngày hạch toán khác ngày giao dịch
  });
  it("giờ giao dịch theo giờ Việt Nam", () => {
    expect(parseVnDateTime("15/10/2026 11:07:44")?.toISOString()).toBe("2026-10-15T04:07:44.000Z");
  });
  it("cảnh báo khi tổng không khớp", () => {
    const bad = grid.map((r) => [...r]);
    bad[13][3] = 1;
    expect(parseStatementGrid(bad).warnings.join()).toMatch(/TỔNG TIỀN/);
  });
  it("file không phải sao kê thì báo lỗi dễ hiểu", () => {
    expect(() => parseStatementGrid([["abc"], ["def"]])).toThrow(/Không tìm thấy bảng giao dịch/);
  });
  it("số tiền dạng chữ", () => {
    expect(parseAmount("1,234,567")).toBe(1_234_567);
    expect(parseAmount("1.234.567")).toBe(1_234_567);
    expect(parseAmount("1,234,567.00")).toBe(1_234_567);
    expect(parseAmount(null)).toBe(0);
  });
});

describe("Gợi ý phân loại", () => {
  const ctx = {
    properties: [{ id: "VTP", codes: ["vtp"] }, { id: "KT", codes: ["kt"] }, { id: "NTG", codes: ["ntg"] }],
    categories: ["Vật tư tiêu hao", "Lương", "Bảo trì", "Điện nước", "Kế toán"].map((n) => ({ id: n, name: n })),
  };
  const p = parseStatementGrid(grid);
  const s = (i: number, extra = {}) => classifyTransaction(p.rows[i], { ...ctx, ...extra });

  it("mã cơ sở trong nội dung", () => {
    expect(s(0)).toMatchObject({ propertyId: "VTP", categoryId: "Vật tư tiêu hao", month: "2026-10", description: "khd vtp nuoc giat · Lo Thi A" });
  });
  it("hai mã cơ sở → để kế toán chọn", () => {
    expect(s(1).propertyId).toBeUndefined();
    expect(s(1).categoryId).toBe("Bảo trì");
  });
  it("lương t9 trả tháng 10 → hạch toán tháng 10 (tháng trả tiền)", () => {
    expect(s(3)).toMatchObject({ propertyId: "VTP", categoryId: "Lương", month: "2026-10" });
  });
  it('"coso" → chi phí chung', () => {
    expect(s(4)).toMatchObject({ propertyId: null, categoryId: "Lương" });
  });
  it("hóa đơn điện: mô tả gọn, học cơ sở theo mã khách hàng", () => {
    expect(s(5)).toMatchObject({ propertyId: undefined, categoryId: "Điện nước", description: "Tiền điện mã 1446341185" });
    const history = [{ counterparty: "X", content: "VNPAY BILL ELECTRIC 1446341185 abc", categoryId: "Điện nước", propertyId: "KT" }];
    expect(s(5, { history }).propertyId).toBe("KT");
  });
  it("tháng = tháng của ngày hạch toán", () => {
    expect(guessMonth("2027-01-05")).toBe("2027-01");
    expect(guessMonth("2026-12-28")).toBe("2026-12");
  });
  it("bỏ mã tham chiếu cuối nội dung", () => {
    expect(cleanDescription("MBCT coso luong nhan vien Toan t9 D  25ABR4Z/220019 ", "NGUYEN TIEN TOAN")).toBe("coso luong nhan vien Toan t9 · Nguyen Tien Toan");
  });
});

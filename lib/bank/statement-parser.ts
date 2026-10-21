// Đọc file sao kê ngân hàng (Excel). Viết theo mẫu "Bảng kết quả giao dịch" xuất từ MB Bank:
//   phần đầu: tên khách hàng, số tài khoản, kỳ sao kê, số dư đầu kỳ
//   bảng: STT | NGÀY GIAO DỊCH | NGÀY HẠCH TOÁN | PHÁT SINH NỢ | PHÁT SINH CÓ | SỐ DƯ | ĐƠN VỊ THỤ HƯỞNG/ĐƠN VỊ CHUYỂN | NỘI DUNG | BÚT TOÁN
//   cuối: dòng TỔNG TIỀN, số dư cuối kỳ.
// Cột được nhận theo tên tiêu đề (có vài tên thay thế của ngân hàng khác), không theo vị trí cố định.
// Hàm parseStatementGrid thuần (nhận mảng ô) để test; readStatementFile đọc file .xlsx bằng exceljs.
import { createHash } from "node:crypto";

export type Cell = string | number | Date | null | undefined;

export interface StatementRow {
  ref: string; // số bút toán
  txnAt: Date;
  bookedOn: string; // YYYY-MM-DD
  debit: number; // tiền ra
  credit: number; // tiền vào
  balance: number | null;
  counterparty: string | null;
  content: string;
}

export interface ParsedStatement {
  bank: string;
  accountNo: string;
  accountName: string | null;
  fromDate: string | null;
  toDate: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  rows: StatementRow[];
  totalDebit: number;
  totalCredit: number;
  /** Tổng theo dòng TỔNG TIỀN của file, để đối chiếu đọc đủ dòng. */
  fileTotals: { debit: number; credit: number } | null;
  warnings: string[];
}

/** Bỏ dấu, chữ thường, gộp khoảng trắng. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

const COLS = {
  txnAt: ["ngay giao dich", "transaction date", "ngay gd"],
  bookedOn: ["ngay hach toan", "ngay hieu luc", "effective date", "posting date"],
  debit: ["phat sinh no", "so tien ghi no", "ghi no", "debit", "rut ra", "tien ra"],
  credit: ["phat sinh co", "so tien ghi co", "ghi co", "credit", "gui vao", "tien vao"],
  balance: ["so du", "balance"],
  counterparty: ["don vi thu huong", "doi ung", "ten tai khoan doi ung", "nguoi huong", "counterparty", "beneficiary"],
  content: ["noi dung", "mo ta", "dien giai", "description", "details"],
  ref: ["but toan", "so tham chieu", "so but toan", "ma giao dich", "reference", "so ct"],
} as const;
type Col = keyof typeof COLS;

function cellText(c: Cell): string {
  if (c == null) return "";
  if (c instanceof Date) return c.toISOString();
  return String(c);
}

/** "1,234,567" / "1.234.567" / 1234567 / "1,234,567.00" → 1234567 (VND nguyên). */
export function parseAmount(c: Cell): number {
  if (c == null || c === "") return 0;
  if (typeof c === "number") return Math.round(c);
  let s = String(c).replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  // Có phần thập phân 1–2 chữ số ở cuối thì bỏ (VND không có xu)
  s = s.replace(/[.,]\d{1,2}$/, "");
  const n = Number(s.replace(/[.,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "15/10/2026 11:07:44" (giờ VN) hoặc Date của Excel → Date. */
export function parseVnDateTime(c: Cell): Date | null {
  if (c instanceof Date) return isNaN(c.getTime()) ? null : c;
  if (typeof c === "number") {
    // Số ngày kiểu Excel (1900): 25569 = 1970-01-01; coi là giờ VN
    if (c < 20000 || c > 80000) return null;
    return new Date(Math.round((c - 25569) * 86400000) - 7 * 3600000);
  }
  const m = cellText(c).trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [, d, mo, y, h = "0", mi = "0", se = "0"] = m;
  const iso = `${y}-${pad(+mo)}-${pad(+d)}T${pad(+h)}:${pad(+mi)}:${pad(+se)}+07:00`;
  const dt = new Date(iso);
  return isNaN(dt.getTime()) ? null : dt;
}

/** Ngày theo giờ VN, dạng YYYY-MM-DD. */
export function vnDay(d: Date): string {
  return new Date(d.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

function parseVnDate(s: string): string | null {
  const d = parseVnDateTime(s);
  return d ? vnDay(d) : null;
}

function findHeader(grid: Cell[][]): { row: number; cols: Partial<Record<Col, number>> } | null {
  for (let r = 0; r < Math.min(grid.length, 60); r++) {
    const texts = grid[r].map((c) => fold(cellText(c)));
    const cols: Partial<Record<Col, number>> = {};
    for (const [col, names] of Object.entries(COLS) as [Col, readonly string[]][]) {
      // Ưu tiên khớp đúng tên; "so du" không được ăn nhầm "so du dau ky" ở phần đầu (đã giới hạn trong cùng dòng tiêu đề)
      const idx = texts.findIndex((t, i) => !Object.values(cols).includes(i) && names.some((n) => t === n || t.startsWith(n + " ") || t.startsWith(n + "/") || t.includes(n)));
      if (idx >= 0) cols[col] = idx;
    }
    if (cols.txnAt !== undefined && cols.content !== undefined && (cols.debit !== undefined || cols.credit !== undefined)) return { row: r, cols };
  }
  return null;
}

/** Đọc bảng ô (đã lấy từ sheet) thành sao kê. Lỗi định dạng ném Error với thông báo tiếng Việt. */
export function parseStatementGrid(grid: Cell[][]): ParsedStatement {
  const header = findHeader(grid);
  if (!header) throw new Error("Không tìm thấy bảng giao dịch (cần các cột Ngày giao dịch, Nội dung, Phát sinh nợ/có). File có đúng là sao kê xuất từ ngân hàng?");
  const { row: hr, cols } = header;
  const warnings: string[] = [];

  // Phần đầu: thông tin tài khoản
  const top = grid.slice(0, hr).flat().map(cellText).join("\n");
  const accountNo = top.match(/(?:Tài khoản|Số tài khoản|Account No)[^:\d\n]{0,20}:?\s*(\d{6,20})/i)?.[1] ?? "";
  const accountName = top.match(/(?:Tên khách hàng|Tên tài khoản|Customer name|Account name)[^:]*:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const fromDate = top.match(/(?:Từ ngày|\bFrom\b)[^:\d\n]{0,12}:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
  const toDate = top.match(/(?:Đến ngày|\bTo\b)[^:\d\n]{0,12}:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1];
  const opening = top.match(/(?:Số dư đầu kỳ|Opening Balance)[^:\d\n]{0,20}:?\s*(-?[\d.,]+)/i)?.[1];
  const bank = /quân đội|mbbank|\bMB\b/i.test(top + grid.flat().map(cellText).join(" ").slice(-2000)) ? "MB" : "Khác";

  const rows: StatementRow[] = [];
  let fileTotals: ParsedStatement["fileTotals"] = null;
  let closing: number | null = null;
  const get = (r: Cell[], c: Col) => (cols[c] === undefined ? null : r[cols[c]!]);

  for (let r = hr + 1; r < grid.length; r++) {
    const line = grid[r];
    const joined = line.map(cellText).join(" ");
    const f = fold(joined);
    if (/tong tien|tong cong|total/.test(f) && !parseVnDateTime(get(line, "txnAt"))) {
      fileTotals = { debit: parseAmount(get(line, "debit")), credit: parseAmount(get(line, "credit")) };
      continue;
    }
    const cm = joined.match(/(?:Số dư cuối kỳ|Closing Balance)[^:\d]*:?\s*(-?[\d.,]+)/i);
    if (cm) closing = parseAmount(cm[1]);
    const txnAt = parseVnDateTime(get(line, "txnAt"));
    if (!txnAt) continue;
    const content = cellText(get(line, "content")).replace(/\s+/g, " ").trim();
    const debit = parseAmount(get(line, "debit"));
    const credit = parseAmount(get(line, "credit"));
    if (!debit && !credit) continue;
    const bookedRaw = get(line, "bookedOn");
    const booked = bookedRaw instanceof Date ? vnDay(bookedRaw) : parseVnDate(cellText(bookedRaw)) ?? vnDay(txnAt);
    const balRaw = get(line, "balance");
    const counterparty = cellText(get(line, "counterparty")).replace(/\s+/g, " ").trim() || null;
    let ref = cellText(get(line, "ref")).trim();
    if (!ref) {
      // Không có số bút toán: tạo mã ổn định từ nội dung để tải lại không bị nhân đôi
      ref = "H" + createHash("sha1").update([txnAt.toISOString(), debit, credit, content].join("|")).digest("hex").slice(0, 16);
    }
    rows.push({ ref, txnAt, bookedOn: booked, debit, credit, balance: balRaw == null || balRaw === "" ? null : parseAmount(balRaw), counterparty, content });
  }
  if (!rows.length) throw new Error("File không có dòng giao dịch nào");
  if (!accountNo) warnings.push("Không đọc được số tài khoản ở phần đầu file");

  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.ref)) warnings.push(`Bút toán ${r.ref} xuất hiện 2 lần trong file, chỉ lấy dòng đầu`);
    seen.add(r.ref);
  }
  const unique = rows.filter((r, i) => rows.findIndex((x) => x.ref === r.ref) === i);
  const totalDebit = unique.reduce((s, r) => s + r.debit, 0);
  const totalCredit = unique.reduce((s, r) => s + r.credit, 0);
  if (fileTotals && (fileTotals.debit !== totalDebit || fileTotals.credit !== totalCredit)) {
    warnings.push(`Tổng đọc được (nợ ${totalDebit.toLocaleString("vi-VN")}, có ${totalCredit.toLocaleString("vi-VN")}) khác dòng TỔNG TIỀN của file — kiểm tra lại file`);
  }

  return {
    bank, accountNo, accountName, fromDate: fromDate ? parseVnDate(fromDate) : null, toDate: toDate ? parseVnDate(toDate) : null,
    openingBalance: opening ? parseAmount(opening) : null, closingBalance: closing, rows: unique, totalDebit, totalCredit, fileTotals, warnings,
  };
}

/** Đọc file .xlsx (sheet đầu tiên có bảng giao dịch). */
export async function readStatementFile(data: ArrayBuffer): Promise<ParsedStatement> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as never);
  } catch {
    throw new Error("Không đọc được file. Tải lên file Excel (.xlsx) xuất từ ngân hàng; file .xls cũ thì mở bằng Excel và lưu lại dạng .xlsx.");
  }
  let lastErr: unknown = null;
  for (const ws of wb.worksheets) {
    const grid: Cell[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      const vals: Cell[] = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        const v = cell.value as unknown;
        let out: Cell = null;
        if (v == null) out = null;
        else if (typeof v === "string" || typeof v === "number" || v instanceof Date) out = v;
        else if (typeof v === "object" && v && "richText" in v) out = (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
        else if (typeof v === "object" && v && "result" in v) out = (v as { result: Cell }).result ?? null;
        else if (typeof v === "object" && v && "text" in v) out = String((v as { text: unknown }).text);
        else out = String(v);
        vals[c - 1] = out;
      });
      grid[n - 1] = vals;
    });
    for (let i = 0; i < grid.length; i++) grid[i] ??= [];
    try {
      return parseStatementGrid(grid);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("File không có sheet nào");
}

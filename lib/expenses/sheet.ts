// Bảng kê chi phí dạng file Excel — dùng chung cho nhập (kê khai hàng loạt) và xuất.
// Cột theo mẫu bảng tổng hợp chi phí tháng của kế toán:
//   Ngày | Khoản chi | Nhóm chi phí | Cơ sở | Người nhận | Số tiền | Ghi chú | Thuộc tháng
// Cột được nhận theo tên tiêu đề (bỏ dấu, không phân biệt hoa thường), không theo vị trí.
// App lưu một ô "Mô tả": Khoản chi · Người nhận: … · Ghi chú: … — xuất file tách lại đúng 3 cột.
import { fold, parseAmount, parseVnDateTime, vnDay, type Cell } from "../bank/statement-parser";

export const SHEET_COLUMNS = ["Ngày", "Khoản chi", "Nhóm chi phí", "Cơ sở", "Người nhận", "Số tiền", "Ghi chú", "Thuộc tháng"] as const;

const COLS = {
  date: ["ngay", "ngay chi", "ngay phat sinh", "ngay thanh toan"],
  item: ["khoan chi", "noi dung", "mo ta", "dien giai"],
  category: ["nhom chi phi", "loai chi phi", "nhom", "loai"],
  property: ["co so", "toa nha", "can"],
  recipient: ["nguoi nhan", "don vi nhan", "nguoi huong", "don vi thu huong"],
  amount: ["so tien", "thanh tien", "tien"],
  note: ["ghi chu"],
  month: ["thuoc thang", "thang hach toan", "thang"],
} as const;
type Col = keyof typeof COLS;
const REQUIRED: Col[] = ["date", "item", "category", "property", "amount"];
const LABEL: Record<Col, string> = {
  date: "Ngày", item: "Khoản chi", category: "Nhóm chi phí", property: "Cơ sở", recipient: "Người nhận", amount: "Số tiền", note: "Ghi chú", month: "Thuộc tháng",
};

export interface SheetRow {
  /** Số dòng trong file (bắt đầu từ 1) để báo lỗi. */
  line: number;
  incurredOn: string | null; // YYYY-MM-DD
  item: string;
  category: string;
  property: string;
  recipient: string;
  amount: number;
  note: string;
  /** Tháng ghi ở cột Thuộc tháng, đã quy ra YYYY-MM (null nếu trống / không đọc được). */
  fileMonth: string | null;
  /** Nội dung gốc ô Thuộc tháng, để báo lỗi. */
  monthText: string;
  errors: string[];
}

const text = (c: Cell) => (c == null ? "" : c instanceof Date ? vnDay(c) : String(c)).replace(/\s+/g, " ").trim();
const pad = (n: number) => String(n).padStart(2, "0");

function findHeader(grid: Cell[][]): { row: number; cols: Partial<Record<Col, number>> } | null {
  for (let r = 0; r < Math.min(grid.length, 30); r++) {
    const texts = grid[r].map((c) => fold(text(c)));
    const cols: Partial<Record<Col, number>> = {};
    // Khớp đúng tên trước, rồi mới khớp "bắt đầu bằng" — để "Ngày" không ăn nhầm cột khác
    for (const exact of [true, false]) {
      for (const [col, names] of Object.entries(COLS) as [Col, readonly string[]][]) {
        if (cols[col] !== undefined) continue;
        const idx = texts.findIndex((t, i) => !!t && !Object.values(cols).includes(i) && names.some((n) => (exact ? t === n : t.startsWith(n + " ") || t.startsWith(n + "("))));
        if (idx >= 0) cols[col] = idx;
      }
    }
    if (REQUIRED.every((c) => cols[c] !== undefined)) return { row: r, cols };
  }
  return null;
}

/** Ngày: ô Date của Excel, "03/10/2026", "3-10-2026", "2026-10-03". */
export function parseSheetDate(c: Cell): string | null {
  if (c instanceof Date) return isNaN(c.getTime()) ? null : vnDay(c);
  const s = text(c);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const d = parseVnDateTime(typeof c === "number" ? c : s);
  return d ? vnDay(d) : null;
}

/**
 * "T10", "t9", "Tháng 9", "9", "10/2026", "2026-10", ô Date → YYYY-MM.
 * Chỉ ghi số tháng thì lấy năm gần ngày chi nhất (T12 chi ngày 02/01/2027 → 2026-12; T1 chi 28/12/2026 → 2027-01).
 */
export function parseSheetMonth(c: Cell, incurredOn: string | null): string | null {
  if (c instanceof Date) return isNaN(c.getTime()) ? null : vnDay(c).slice(0, 7);
  const s = fold(text(c));
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m) return +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${pad(+m[2])}` : null;
  m = s.match(/^(?:t|thang)?\s*(\d{1,2})\s*[/-]\s*(\d{4})$/);
  if (m) return +m[1] >= 1 && +m[1] <= 12 ? `${m[2]}-${pad(+m[1])}` : null;
  m = s.match(/^(?:t|thang)?\s*(\d{1,2})$/);
  if (!m || +m[1] < 1 || +m[1] > 12 || !incurredOn) return null;
  const mo = +m[1];
  const y = +incurredOn.slice(0, 4);
  const base = y * 12 + (+incurredOn.slice(5, 7) - 1);
  const best = [y - 1, y, y + 1].map((yy) => yy * 12 + mo - 1).sort((a, b) => Math.abs(a - base) - Math.abs(b - base))[0];
  return `${Math.floor(best / 12)}-${pad((best % 12) + 1)}`;
}

/** Đọc bảng ô thành các dòng chi phí. Lỗi định dạng chung ném Error; lỗi từng dòng nằm trong row.errors. */
export function parseExpenseGrid(grid: Cell[][]): SheetRow[] {
  const header = findHeader(grid);
  if (!header) {
    throw new Error(`Không tìm thấy dòng tiêu đề. File cần các cột: ${REQUIRED.map((c) => LABEL[c]).join(", ")} (thêm Người nhận, Ghi chú, Thuộc tháng nếu có). Tải file mẫu để xem đúng định dạng.`);
  }
  const { row: hr, cols } = header;
  const get = (r: Cell[], c: Col) => (cols[c] === undefined ? null : r[cols[c]!]);
  const rows: SheetRow[] = [];
  for (let r = hr + 1; r < grid.length; r++) {
    const line = grid[r] ?? [];
    const item = text(get(line, "item"));
    const rawAmount = get(line, "amount");
    const rawDate = get(line, "date");
    // Dòng trống, dòng tổng cộng
    if (!item && !text(rawAmount) && !text(rawDate)) continue;
    if (/^tong\b|^cong\b|^total\b/.test(fold(text(rawDate) || item))) continue;
    const incurredOn = parseSheetDate(rawDate);
    const amount = parseAmount(rawAmount);
    const monthText = text(get(line, "month"));
    const fileMonth = parseSheetMonth(get(line, "month"), incurredOn);
    const row: SheetRow = {
      line: r + 1, incurredOn, item, category: text(get(line, "category")), property: text(get(line, "property")),
      recipient: text(get(line, "recipient")), amount, note: text(get(line, "note")), fileMonth, monthText, errors: [],
    };
    if (!incurredOn) row.errors.push(`Ngày "${text(rawDate)}" không đọc được (dạng 03/10/2026)`);
    if (!item) row.errors.push("Thiếu Khoản chi");
    if (!row.category) row.errors.push("Thiếu Nhóm chi phí");
    if (!row.property) row.errors.push("Thiếu Cơ sở");
    if (!(amount > 0)) row.errors.push("Số tiền phải lớn hơn 0");
    if (monthText && !fileMonth) row.errors.push(`Thuộc tháng "${monthText}" không đọc được (dạng T10)`);
    rows.push(row);
  }
  if (!rows.length) throw new Error("File không có dòng chi phí nào dưới dòng tiêu đề");
  return rows;
}

const RECIPIENT = " · Người nhận: ";
const NOTE = " · Ghi chú: ";

/** Ghép 3 cột thành mô tả khoản chi lưu trong app. */
export function buildDescription(r: { item: string; recipient?: string; note?: string }): string {
  return `${r.item.trim()}${r.recipient?.trim() ? RECIPIENT + r.recipient.trim() : ""}${r.note?.trim() ? NOTE + r.note.trim() : ""}`;
}

/** Tách mô tả về 3 cột khi xuất file (mô tả nhập tay không có phần Người nhận / Ghi chú thì nằm hết ở Khoản chi). */
export function splitDescription(desc: string): { item: string; recipient: string; note: string } {
  let rest = desc;
  let note = "";
  let recipient = "";
  const n = rest.lastIndexOf(NOTE);
  if (n >= 0) [rest, note] = [rest.slice(0, n), rest.slice(n + NOTE.length)];
  const p = rest.lastIndexOf(RECIPIENT);
  if (p >= 0) [rest, recipient] = [rest.slice(0, p), rest.slice(p + RECIPIENT.length)];
  return { item: rest, recipient, note };
}

/** "2026-10" → "T10" (thêm năm nếu khác năm của ngày chi). */
export function monthLabel(month: string, incurredOn: string): string {
  const t = `T${Number(month.slice(5))}`;
  return month.slice(0, 4) === incurredOn.slice(0, 4) ? t : `${t}/${month.slice(0, 4)}`;
}

/** Tên cơ sở / loại so khớp: bỏ dấu, bỏ ký tự thừa. */
export const nameKey = (s: string) => fold(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Ô Cơ sở ghi chi phí chung. */
export const isCommonName = (s: string) => /^(chi phi )?chung\b|^unix$|^cp chung/.test(nameKey(s));

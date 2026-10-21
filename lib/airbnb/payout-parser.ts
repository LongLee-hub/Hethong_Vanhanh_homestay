// Tách email payout của Airbnb (tiếng Anh và tiếng Việt) thành tổng tiền + từng đơn.
// Thuần TypeScript, không gọi mạng; dùng cho job đồng bộ, nút "Tách lại" và test.
//
// TODO(CONFIRM): bộ tách viết theo mẫu email payout phổ biến của Airbnb (dòng tổng "We sent a payout of …" /
// "Chúng tôi đã gửi … khoản thanh toán …", sau đó mỗi đơn có tên khách, ngày ở, listing, mã HM… và số tiền).
// Cần đối chiếu với vài email thật của LOCI; email nào tách thiếu sẽ hiện "Tách được một phần" để sửa bộ tách.

export interface ParsedPayoutItem {
  confirmationCode: string;
  guestName: string | null;
  checkIn: string | null; // YYYY-MM-DD
  checkOut: string | null;
  amount: number | null; // null = email không ghi tiền riêng cho đơn này
}

export interface ParsedPayout {
  isPayout: boolean;
  /** Lý do bỏ qua khi isPayout = false (thư báo payout lỗi, thư đặt phòng…). */
  skipReason?: string;
  amount: number | null;
  currency: string;
  items: ParsedPayoutItem[];
  status: "OK" | "PARTIAL" | "FAILED";
  note: string | null;
}

/** Mã xác nhận đặt phòng Airbnb: HM + 8 ký tự chữ hoa/số. */
export const CONFIRMATION_CODE_RE = /\bHM[A-Z0-9]{8}\b/g;

const PAYOUT_SUBJECT = /payout|khoản thanh toán|khoản chi trả|khoản tiền chi trả|đã gửi .*tiền/i;
// Thư không phải "đã chuyển tiền": payout lỗi, bị giữ, nhắc cập nhật phương thức nhận tiền, báo thuế…
const NOT_A_SENT_PAYOUT = /fail|unsuccessful|on hold|paused|update|add a payout|set up|tax|thất bại|không thành công|bị giữ|tạm dừng|cập nhật|thiết lập|thêm phương thức|thuế/i;

// ---------- Tiền ----------

const CURRENCY_HINT = /(₫|VND|VNĐ|\dđ|\d\s+đ(?![\p{L}])|\$|USD|€|EUR)/iu;
// Một số tiền có ký hiệu tiền tệ ở trước hoặc sau: "₫1,234,567", "1.234.567 ₫", "₫1.234.567 VND", "$123.45 USD"
const MONEY_RE = /(?:(₫|\$|€)\s?(-?\d[\d.,]*\d|\d)(?:\s?(VND|VNĐ|USD|EUR))?)|(?:(-?\d[\d.,]*\d|\d)\s?(₫|đ|VND|VNĐ|USD|EUR)(?![\p{L}]))/giu;

export interface Money {
  amount: number;
  currency: string;
  index: number;
}

function currencyOf(sym: string): string {
  const s = sym.toUpperCase();
  if (s === "$" || s === "USD") return "USD";
  if (s === "€" || s === "EUR") return "EUR";
  return "VND";
}

/** "1,234,567" / "1.234.567" / "123.45" / "1.234,56" → số. VND luôn là số nguyên nên mọi dấu . , đều là phân cách nghìn. */
export function parseNumber(raw: string, currency: string): number | null {
  const neg = raw.trim().startsWith("-");
  const s = raw.replace(/^-/, "");
  let n: number;
  if (currency === "VND") {
    n = Number(s.replace(/[.,\s]/g, ""));
  } else {
    // Dấu cuối cùng cách đúng 2 chữ số ở cuối là dấu thập phân
    const m = s.match(/^(.*)[.,](\d{1,2})$/);
    n = m ? Number(`${m[1].replace(/[.,]/g, "")}.${m[2]}`) : Number(s.replace(/[.,]/g, ""));
  }
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function findMoney(line: string): Money[] {
  const out: Money[] = [];
  for (const m of line.matchAll(MONEY_RE)) {
    const sym = m[1] ?? m[5] ?? "";
    const cur = currencyOf(m[3] ?? sym);
    const raw = m[2] ?? m[4] ?? "";
    const n = parseNumber(raw, cur);
    if (n !== null) out.push({ amount: cur === "VND" ? Math.round(n) : Math.round(n * 100) / 100, currency: cur, index: m.index ?? 0 });
  }
  return out;
}

// ---------- Ngày ----------

const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);
const enMonth = (s: string) => EN_MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
const DASH = "\\s*[–—-]\\s*";

/** Khoảng ngày ở trong một dòng. Năm bị thiếu ở ngày đầu thì lấy năm của ngày sau (lùi 1 năm nếu qua năm mới). */
export function parseDateRange(line: string): { checkIn: string; checkOut: string } | null {
  let m: RegExpMatchArray | null;
  // 03/10/2026 – 05/10/2026 (ngày/tháng/năm, kiểu Việt Nam)
  if ((m = line.match(new RegExp(`(\\d{1,2})/(\\d{1,2})/(\\d{4})${DASH}(\\d{1,2})/(\\d{1,2})/(\\d{4})`)))) {
    const a = iso(+m[3], +m[2], +m[1]), b = iso(+m[6], +m[5], +m[4]);
    return a && b ? { checkIn: a, checkOut: b } : null;
  }
  // 2026-10-03 – 2026-10-05
  if ((m = line.match(new RegExp(`(\\d{4})-(\\d{2})-(\\d{2})${DASH}(\\d{4})-(\\d{2})-(\\d{2})`)))) {
    return { checkIn: `${m[1]}-${m[2]}-${m[3]}`, checkOut: `${m[4]}-${m[5]}-${m[6]}` };
  }
  const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
  // Oct 30, 2026 – Nov 2, 2026 | Oct 30 – Nov 2, 2026 | Dec 30, 2026 – Jan 2, 2027
  if ((m = line.match(new RegExp(`${MON}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?${DASH}${MON}\\s+(\\d{1,2}),\\s*(\\d{4})`, "i")))) {
    const y2 = +m[6], m1 = enMonth(m[1]), m2 = enMonth(m[4]);
    const y1 = m[3] ? +m[3] : m1 > m2 ? y2 - 1 : y2;
    const a = iso(y1, m1, +m[2]), b = iso(y2, m2, +m[5]);
    return a && b ? { checkIn: a, checkOut: b } : null;
  }
  // Oct 3 – 5, 2026
  if ((m = line.match(new RegExp(`${MON}\\s+(\\d{1,2})${DASH}(\\d{1,2}),\\s*(\\d{4})`, "i")))) {
    const mo = enMonth(m[1]);
    const a = iso(+m[4], mo, +m[2]), b = iso(+m[4], mo, +m[3]);
    return a && b ? { checkIn: a, checkOut: b } : null;
  }
  // 30 thg 10, 2026 – 2 thg 11, 2026 | 30 thg 10 – 2 thg 11, 2026 | 30 tháng 10 – 2 tháng 11 năm 2026
  const TH = "(?:thg|tháng)\\s*(\\d{1,2})";
  const YR = "(?:,|\\s+năm)\\s*(\\d{4})";
  if ((m = line.match(new RegExp(`(\\d{1,2})\\s*${TH}(?:${YR})?${DASH}(\\d{1,2})\\s*${TH}${YR}`, "i")))) {
    const y2 = +m[6], m1 = +m[2], m2 = +m[5];
    const y1 = m[3] ? +m[3] : m1 > m2 ? y2 - 1 : y2;
    const a = iso(y1, m1, +m[1]), b = iso(y2, m2, +m[4]);
    return a && b ? { checkIn: a, checkOut: b } : null;
  }
  // 3 – 5 thg 10, 2026
  if ((m = line.match(new RegExp(`(\\d{1,2})${DASH}(\\d{1,2})\\s*${TH}${YR}`, "i")))) {
    const a = iso(+m[4], +m[3], +m[1]), b = iso(+m[4], +m[3], +m[2]);
    return a && b ? { checkIn: a, checkOut: b } : null;
  }
  return null;
}

// ---------- Tên khách ----------

const LABEL_LINE = /^(guest|khách|listing|chỗ ở|nhà\/phòng cho thuê|confirmation|mã xác nhận|dates|ngày|amount|số tiền|details|chi tiết|reservation|đặt phòng|payout|thanh toán|total|tổng|home|nights?|đêm)\b/i;

function guestFrom(lines: string[]): string | null {
  for (const l of lines) {
    const labeled = l.match(/^(?:guest|khách)\s*[:：]\s*(.+)$/i);
    if (labeled) return labeled[1].trim();
  }
  // Không có nhãn: dòng đầu tiên chỉ gồm chữ (tên người), không phải nhãn, ngày hay tiền
  for (const l of lines) {
    if (l.length < 2 || l.length > 60 || /\d/.test(l) || LABEL_LINE.test(l) || CURRENCY_HINT.test(l)) continue;
    if (/^[\p{L}][\p{L}\s.'’-]*$/u.test(l)) return l;
  }
  return null;
}

// ---------- Tách cả email ----------

/** Dòng tổng của payout, để không lấy nhầm tổng tiền làm tiền của đơn đầu tiên. */
const TOTAL_LINE = /sent (you )?a payout|payout of|đã gửi|khoản thanh toán|khoản chi trả|total|tổng/i;

export function parsePayoutEmail(input: { subject: string; text: string }): ParsedPayout {
  const subject = input.subject ?? "";
  const empty = { amount: null, currency: "VND", items: [], status: "FAILED" as const, note: null };
  if (!PAYOUT_SUBJECT.test(subject)) return { ...empty, isPayout: false, skipReason: "Không phải thư payout" };
  if (NOT_A_SENT_PAYOUT.test(subject)) return { ...empty, isPayout: false, skipReason: "Thư báo payout lỗi hoặc nhắc cập nhật, không phải tiền đã chuyển" };

  const lines = input.text.split("\n").map((l) => l.trim()).filter(Boolean);

  // Tổng tiền: ưu tiên số tiền trong tiêu đề, không có thì dòng tổng đầu tiên trong thân thư
  let total: Money | undefined = findMoney(subject)[0];
  let totalLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!TOTAL_LINE.test(lines[i])) continue;
    const m = findMoney(lines[i])[0];
    if (m && (!total || m.amount === total.amount)) { total ??= m; totalLine = i; break; }
  }

  // Vị trí từng mã xác nhận (mỗi mã lấy lần xuất hiện đầu)
  const codes: { code: string; line: number }[] = [];
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    for (const m of l.matchAll(CONFIRMATION_CODE_RE)) if (!seen.has(m[0])) { seen.add(m[0]); codes.push({ code: m[0], line: i }); }
  });

  const items: ParsedPayoutItem[] = [];
  let prevEnd = totalLine; // dòng cuối đã thuộc về đơn trước
  for (let k = 0; k < codes.length; k++) {
    const { code, line } = codes[k];
    const nextCode = codes[k + 1]?.line ?? lines.length;
    // Tiền của đơn: số tiền đầu tiên từ dòng chứa mã trở đi (trước mã kế tiếp); không có thì số tiền cuối cùng ngay trước mã
    let amount: number | null = null;
    let end = line;
    for (let j = line; j < nextCode; j++) {
      const text = j === line ? lines[j].slice(lines[j].indexOf(code) + code.length) : lines[j];
      const m = findMoney(text)[0];
      if (m) { amount = m.amount; end = j; break; }
    }
    const before = lines.slice(prevEnd + 1, line);
    if (amount === null) {
      for (let j = before.length - 1; j >= 0; j--) {
        const m = findMoney(before[j]).at(-1);
        if (m) { amount = m.amount; break; }
      }
    }
    const block = lines.slice(prevEnd + 1, end + 1);
    const range = block.map(parseDateRange).find(Boolean) ?? null;
    items.push({ confirmationCode: code, guestName: guestFrom(before), checkIn: range?.checkIn ?? null, checkOut: range?.checkOut ?? null, amount });
    prevEnd = end;
  }

  const notes: string[] = [];
  if (!total) notes.push("Không đọc được tổng tiền");
  if (total && total.currency !== "VND") notes.push(`Tiền tệ ${total.currency}, không đối soát được với doanh thu VND`);
  if (!items.length) notes.push("Không thấy mã đặt phòng (HM…)");
  else if (items.some((i) => i.amount === null)) notes.push("Có đơn không đọc được số tiền");
  else if (total && total.currency === "VND") {
    const sum = items.reduce((s, i) => s + (i.amount ?? 0), 0);
    if (sum !== total.amount) notes.push(`Tổng tiền các đơn (${sum.toLocaleString("vi-VN")}) khác tổng payout (${total.amount.toLocaleString("vi-VN")})`);
  }
  const status = !total && !items.length ? "FAILED" : notes.length ? "PARTIAL" : "OK";
  return { isPayout: true, amount: total?.amount ?? null, currency: total?.currency ?? "VND", items, status, note: notes.join("; ") || null };
}

// Tách email payout của Airbnb, viết theo Apps Script "AIRBNB PAYOUT EMAIL IMPORTER v2" LOCI đang chạy.
// Thuần TypeScript, không gọi mạng; dùng cho job đồng bộ, nút "Tách lại", dán email trên web và test.
//
// Cấu trúc email (bản text/plain, gửi từ automated@airbnb.com):
//   Chi tiết | Details
//   <Tên khách>  <$16,30 USD>            ← cùng dòng (cách ≥ 2 dấu cách) hoặc số tiền ở dòng sau
//   <Loại> • <d/M/yyyy> - <d/M/yyyy>     ← Nơi lưu trú / vn_income_tax_withholding / vn_vat_withholding…
//   <Tên listing> (<Listing ID>)
//   <Mã đặt phòng>
//   … (lặp lại cho từng dòng giao dịch; một đơn thường có dòng tiền phòng và các dòng thuế âm)
//   Tổng số tiền đã chi trả: ₫2.335.042 VND | Total paid out: …
//   Mã khoản chi trả | Payout ID  <mã>
//
// Tiền từng dòng là USD; VNĐ từng dòng = USD × (tổng VNĐ email ÷ tổng USD của chính email đó),
// phần dư làm tròn dồn vào dòng có |USD| lớn nhất để tổng VNĐ khớp đúng số tiền email.

export type LineType = string;

export interface ParsedPayoutItem {
  confirmationCode: string | null;
  guestName: string | null;
  lineType: LineType | null; // "Tiền phòng", "Thuế TNCN", "Thuế VAT", "Phí dọn dẹp" hoặc nguyên văn
  checkIn: string | null; // YYYY-MM-DD
  checkOut: string | null;
  listingName: string | null;
  listingId: string | null;
  usdAmount: number; // USD của dòng, có thể âm (thuế khấu trừ)
  amount: number | null; // VNĐ phân bổ; null khi email không có tổng VNĐ
}

export interface ParsedPayout {
  isPayout: boolean;
  /** Lý do bỏ qua khi isPayout = false. */
  skipReason?: string;
  payoutCode: string | null; // "Mã khoản chi trả" — chống trùng khi Airbnb gửi lặp email
  amount: number | null; // tổng VNĐ email
  currency: string;
  totalUsd: number;
  exchangeRate: number | null; // VNĐ / USD của email
  items: ParsedPayoutItem[];
  status: "OK" | "PARTIAL" | "FAILED";
  note: string | null;
}

/** Dòng nhận diện email payout (giống điều kiện lọc trong Apps Script). */
export const PAYOUT_MARKER = /Tổng số tiền đã chi trả|Total paid out/i;

/** Các loại dòng là thuế Airbnb khấu trừ trước khi chuyển tiền. */
export const TAX_TYPES = new Set(["Thuế TNCN", "Thuế VAT"]);

const TYPE_MAP: Record<string, string> = {
  vn_income_tax_withholding: "Thuế TNCN",
  vn_vat_withholding: "Thuế VAT",
  "Nơi lưu trú": "Tiền phòng",
  Accommodation: "Tiền phòng",
  "Income tax withholding": "Thuế TNCN",
  "VAT withholding": "Thuế VAT",
  "Cleaning fee": "Phí dọn dẹp",
  "Phí dọn dẹp": "Phí dọn dẹp",
};
export const mapTransactionType = (raw: string) => TYPE_MAP[raw] ?? raw;

// ---------- Tiền ----------

/**
 * Đọc số tiền mọi dạng: "$16,30 USD" | "-$1.234,56 USD" | "2.335.042" | "1,234.56".
 * Dấu phân cách cuối cùng theo sau bởi 1–2 chữ số được coi là dấu thập phân (giống parseMoney của script).
 */
export function parseMoney(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  let s = String(v ?? "").replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  const neg = s.includes("-");
  s = s.replace(/-/g, "");
  const pos = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let intPart = s, decPart = "";
  if (pos >= 0) {
    const after = s.length - pos - 1;
    if (after >= 1 && after <= 2) { intPart = s.slice(0, pos); decPart = s.slice(pos + 1); }
  }
  intPart = intPart.replace(/[.,]/g, "");
  const n = parseFloat((intPart || "0") + (decPart ? "." + decPart : "")) || 0;
  return neg ? -n : n;
}

/** Tổng VNĐ: "Tổng số tiền đã chi trả: ₫2.335.042 VND". VNĐ không có phần lẻ nên bỏ mọi dấu phân cách. */
export function extractTotalVND(body: string): number | null {
  const pats = [/Tổng số tiền đã chi trả:?\s*₫?\s*([\d.,]+)\s*VND/i, /Total paid out:?\s*₫?\s*([\d.,]+)\s*VND/i, /₫\s*([\d.,]+)\s*VND/];
  for (const p of pats) {
    const m = body.match(p);
    if (m) return Number(m[1].replace(/[.,]/g, "")) || null;
  }
  return null;
}

export function extractPayoutCode(body: string): string | null {
  const m = body.match(/(?:Mã khoản chi trả|Payout ID)\s*:?\s*\n*\s*([A-Za-z0-9]{10,})/i);
  return m ? m[1].trim() : null;
}

// ---------- Ngày ----------

const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 86_400_000;

/**
 * Cặp ngày trong email (Airbnb dùng d/M/yyyy hoặc M/d/yyyy tùy ngôn ngữ), theo parseDateRangeStr của script:
 *  1. Một phần > 12 → biết kiểu viết, áp cho cả cặp.
 *  2. Có số 0 đứng đầu ("04") → kiểu Mỹ.
 *  3. Còn mơ hồ → chọn cách đọc hợp lý so với ngày gửi tiền; mặc định kiểu Việt Nam.
 */
export function parseDateRangeStr(cinStr: string, coutStr: string, payDate: string | null): { checkIn: string; checkOut: string } | null {
  const sp = (s: string) => {
    const p = s.trim().split("/");
    if (p.length !== 3) return null;
    const a = parseInt(p[0], 10), b = parseInt(p[1], 10), y = parseInt(p[2], 10);
    if (!(y > 2000)) return null;
    return { a, b, y, lz: (p[0].length === 2 && a <= 9) || (p[1].length === 2 && b <= 9) };
  };
  const x = sp(cinStr), z = sp(coutStr);
  if (!x || !z) return null;
  const mk = (p: NonNullable<typeof x>, us: boolean) => (us ? toIso(p.y, p.a, p.b) : toIso(p.y, p.b, p.a));
  const valid = (c1: string | null, c2: string | null) => {
    if (!c1 || !c2 || !(c1 < c2)) return false;
    if (dayNum(c2) - dayNum(c1) > 400) return false;
    if (!payDate) return true;
    const diff = dayNum(c1) - dayNum(payDate);
    return diff <= 45 && diff >= -400;
  };
  const pair = (us: boolean) => {
    const c1 = mk(x, us), c2 = mk(z, us);
    return c1 && c2 ? { checkIn: c1, checkOut: c2 } : null;
  };

  const usSure = x.b > 12 || z.b > 12;
  const vnSure = x.a > 12 || z.a > 12;
  if (usSure && !vnSure) return pair(true);
  if (vnSure && !usSure) return pair(false);
  if ((x.lz || z.lz) && valid(mk(x, true), mk(z, true))) return pair(true);
  const vOk = valid(mk(x, false), mk(z, false)), uOk = valid(mk(x, true), mk(z, true));
  if (uOk && !vOk) return pair(true);
  return pair(false);
}

// ---------- Các dòng giao dịch ----------

const AMT = /^-?\s?\$\s?[\d.,]+\s*USD$/i;
const INLINE = /^(.+?)\s{2,}(-?\s?\$\s?[\d.,]+\s*USD)$/i;
const TYPE_DATES = /^(.+?)\s*[•·]\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{4})$/;
const LISTING = /^(.+?)\s*\((\d{10,})\)\s*$/;
const CODE = /^[A-Z0-9]{6,12}$/;

/** Đọc phần "Chi tiết" → các dòng giao dịch (theo parseTransactionBlocks của script). */
export function parseTransactionBlocks(body: string, payDate: string | null): Omit<ParsedPayoutItem, "amount">[] {
  const section =
    body.match(/Chi ti[eế]t\s*\n([\s\S]*?)(?:Tổng số tiền đã chi trả|Total paid out)/i) ??
    body.match(/Details\s*\n([\s\S]*?)(?:Total paid out)/i);
  if (!section) return [];
  const lines = section[1].split("\n").map((l) => l.trim()).filter(Boolean);
  const blocks: Omit<ParsedPayoutItem, "amount">[] = [];

  let i = 0;
  while (i < lines.length) {
    let guest: string | null = null, amountStr: string | null = null;
    const inline = lines[i].match(INLINE);
    if (inline) {
      guest = inline[1].trim(); amountStr = inline[2];
    } else if (i + 1 < lines.length && AMT.test(lines[i + 1]) && !AMT.test(lines[i])) {
      guest = lines[i]; amountStr = lines[i + 1]; i++;
    }
    if (!guest) { i++; continue; }

    let lineType: string | null = null, checkIn: string | null = null, checkOut: string | null = null;
    let listingName: string | null = null, listingId: string | null = null, code: string | null = null;

    if (i + 1 < lines.length) {
      const t = lines[i + 1].match(TYPE_DATES);
      if (t) {
        lineType = mapTransactionType(t[1].trim());
        const r = parseDateRangeStr(t[2], t[3], payDate);
        checkIn = r?.checkIn ?? null; checkOut = r?.checkOut ?? null;
        i++;
      } else if (!/\(\d{10,}\)\s*$/.test(lines[i + 1]) && !CODE.test(lines[i + 1]) && !AMT.test(lines[i + 1])) {
        lineType = mapTransactionType(lines[i + 1].split(/[•·]/)[0].trim()); // loại không kèm ngày
        i++;
      }
    }
    if (i + 1 < lines.length) {
      const l = lines[i + 1].match(LISTING);
      if (l) { listingName = l[1].trim(); listingId = l[2].trim(); i++; }
    }
    if (i + 1 < lines.length && CODE.test(lines[i + 1])) { code = lines[i + 1]; i++; }

    blocks.push({ confirmationCode: code, guestName: guest, lineType, checkIn, checkOut, listingName, listingId, usdAmount: parseMoney(amountStr) });
    i++;
  }
  return blocks;
}

/**
 * Chia tổng VNĐ của email cho từng dòng theo USD (fillVNDBooking của script):
 * tỷ giá = tổng VNĐ ÷ tổng USD của chính email; phần dư làm tròn dồn vào dòng |USD| lớn nhất.
 */
export function allocateVnd(usd: number[], totalVnd: number | null): { vnd: (number | null)[]; rate: number | null } {
  const totalUsd = usd.reduce((s, u) => s + u, 0);
  if (!totalVnd || Math.abs(totalUsd) < 1e-9) return { vnd: usd.map(() => null), rate: null };
  const rate = totalVnd / totalUsd;
  const vnd: (number | null)[] = usd.map((u) => (u === 0 ? 0 : Math.round(u * rate)));
  let biggest = -1;
  usd.forEach((u, i) => { if (u !== 0 && (biggest < 0 || Math.abs(u) > Math.abs(usd[biggest]))) biggest = i; });
  const sum = vnd.reduce<number>((s, v) => s + (v ?? 0), 0);
  if (biggest >= 0) vnd[biggest] = (vnd[biggest] ?? 0) + (totalVnd - sum);
  return { vnd, rate };
}

export function parsePayoutEmail(input: { subject: string; text: string; payDate?: string | null }): ParsedPayout {
  const body = (input.text ?? "").replace(/\r/g, "");
  const empty = { payoutCode: null, amount: null, currency: "VND", totalUsd: 0, exchangeRate: null, items: [], status: "FAILED" as const, note: null };
  if (!PAYOUT_MARKER.test(body)) return { ...empty, isPayout: false, skipReason: 'Không có dòng "Tổng số tiền đã chi trả" / "Total paid out"' };

  const payoutCode = extractPayoutCode(body);
  const totalVnd = extractTotalVND(body);
  const blocks = parseTransactionBlocks(body, input.payDate ?? null);
  const { vnd, rate } = allocateVnd(blocks.map((b) => b.usdAmount), totalVnd);
  const items: ParsedPayoutItem[] = blocks.map((b, i) => ({ ...b, amount: vnd[i] }));
  const totalUsd = Math.round(blocks.reduce((s, b) => s + b.usdAmount, 0) * 100) / 100;

  const notes: string[] = [];
  if (totalVnd === null) notes.push("Không đọc được tổng VNĐ");
  if (!blocks.length) notes.push('Không đọc được phần "Chi tiết"');
  const noCode = items.filter((i) => !i.confirmationCode).length;
  if (noCode) notes.push(`${noCode} dòng không có mã đặt phòng`);
  const noDate = items.filter((i) => i.confirmationCode && !i.checkIn).length;
  if (noDate) notes.push(`${noDate} dòng không có ngày ở`);
  const status = !blocks.length && totalVnd === null ? "FAILED" : notes.length ? "PARTIAL" : "OK";
  return { isPayout: true, payoutCode, amount: totalVnd, currency: "VND", totalUsd, exchangeRate: rate, items, status, note: notes.join("; ") || null };
}

// ---------- Tách theo tháng (Báo cáo tháng của script) ----------

export interface StayPart {
  month: string; // YYYY-MM
  nights: number;
  totalNights: number;
  checkIn: string;
  checkOut: string;
}

/**
 * Tách một kỳ ở theo tháng (splitStay của script). Phần đầu: check-in → ngày cuối tháng,
 * phần giữa: ngày 1 → ngày cuối tháng, phần cuối: ngày 1 → check-out. null nếu ngày không hợp lệ.
 */
export function splitStay(checkIn: string | null, checkOut: string | null): StayPart[] | null {
  if (!checkIn || !checkOut || !(checkIn < checkOut)) return null;
  const counts = new Map<string, number>();
  for (let d = dayNum(checkIn); d < dayNum(checkOut); d++) {
    const m = new Date(d * 86_400_000).toISOString().slice(0, 7);
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  const entries = [...counts];
  const total = entries.reduce((s, [, n]) => s + n, 0);
  return entries.map(([month, nights], idx) => {
    const [y, mo] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    return {
      month, nights, totalNights: total,
      checkIn: idx === 0 ? checkIn : `${month}-01`,
      checkOut: idx === entries.length - 1 ? checkOut : last,
    };
  });
}

/** Chia số tiền theo số đêm; phần cuối nhận phần dư để tổng khớp đúng (prorate của script). */
export function prorate(amount: number, parts: { nights: number; totalNights: number }[], decimals = 0): number[] {
  if (parts.length === 1) return [amount];
  const f = 10 ** decimals;
  let used = 0;
  return parts.map((p, i) => {
    if (i === parts.length - 1) return Math.round((amount - used) * f) / f;
    const v = Math.round(((amount * p.nights) / p.totalNights) * f) / f;
    used += v;
    return v;
  });
}

/** "NTG402@Oldquarter/Studio/..." → "NTG402"; "Unix76NTG401. Máy chiếu..." → "NTG401" (extractNickname của script). */
export function extractNickname(name: string | null): string {
  if (!name) return "";
  const at = name.indexOf("@");
  if (at > 0) return name.slice(0, at).trim();
  const m = name.match(/NTG\d+/i);
  if (m) return m[0].toUpperCase();
  const dot = name.indexOf(".");
  if (dot > 0 && dot <= 10) return name.slice(0, dot).trim();
  return name.slice(0, 10).trim();
}

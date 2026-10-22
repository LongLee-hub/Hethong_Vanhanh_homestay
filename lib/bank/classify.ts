// Gợi ý phân loại một dòng tiền ra trên sao kê: cơ sở, loại chi phí, tháng hạch toán, mô tả.
// Hàm thuần, kế toán luôn xem và sửa lại trước khi ghi nhận.
//
// Quy ước nội dung chuyển khoản LOCI đang dùng (vd "khd-vtp-nuoc giat", "MBCT pkb luong don dep t9"):
//   - mã cơ sở viết tắt: vp, pkb, ntg, vtp, kt, lt… (đặt ở trang Cơ sở & phòng → "Mã trên sao kê")
//   - "coso" = chi phí chung toàn hệ thống
//   - tháng hạch toán = tháng trả tiền (ngày hạch toán trên sao kê); "t9" trong nội dung không đổi tháng
import { fold } from "./statement-parser";

export const COMMON_CODE = "coso";

export interface ClassifyContext {
  properties: { id: string; codes: string[] }[];
  categories: { id: string; name: string }[];
  /** Các dòng đã ghi nhận trước đây, để học thói quen: người nhận → loại chi phí; mã khách hàng hóa đơn điện nước → cơ sở. */
  history?: { counterparty: string | null; content: string; categoryId: string; propertyId: string | null }[];
}

export interface Suggestion {
  /** undefined = chưa đoán được; null = chi phí chung; string = id cơ sở */
  propertyId: string | null | undefined;
  categoryId: string | undefined;
  month: string;
  description: string;
  /** Lý do gợi ý, hiện cho kế toán xem */
  hints: string[];
  /** Cơ sở và loại đều đoán từ nội dung (mã + từ khóa), không phải học từ lần trước → chọn sẵn để ghi nhận */
  confident: boolean;
}

// Từ khóa → tên loại chi phí (so khớp với tên loại trong hệ thống, không phân biệt dấu). Thứ tự = độ ưu tiên.
const RULES: [RegExp, string[]][] = [
  [/\bbhxh\b|bao hiem xa hoi/, ["BHXH"]],
  [/\bke toan\b/, ["Kế toán"]],
  [/luong|tro cap thoi viec|\bung luong\b|thuong nhan vien/, ["Lương"]],
  [/thue nha|tien nha|tien thue nha/, ["Thuê nhà"]],
  [/bill electric|tien dien|\bevn\b|bill water|\bwater\b|tien nuoc|hawaco|nuoc sach/, ["Điện nước"]],
  [/internet|wifi|netflix|hotline|\bcuoc\b|\bfpt\b|viettel|vnpt|truyen hinh/, ["Internet"]],
  [/giat la|giat ui|tien giat/, ["Giặt là"]],
  [/amenti|amenit|nuoc giat|dau goi|sua tam|dau an|ve sinh|giay|ban chai|tieu hao|do dung|nuoc rua/, ["Vật tư tiêu hao"]],
  [/\bsua\b|thong cong|bao tri|o khoa|o cam|dieu khien|may chieu|voi hoa sen|thay the|bong den/, ["Bảo trì"]],
  [/quang cao|\bads\b|marketing|tiep khach/, ["Marketing"]],
  [/phan mem|software|subscription/, ["Phần mềm"]],
  [/\bthue\b/, ["Thuế"]],
];

const NOISE = /\b(mbct|khd|ibft|ft\d+)\b/g;

/** Mô tả gọn từ nội dung chuyển khoản: bỏ tiền tố MBCT, mã giao dịch cuối (vd "D25ER3Y5/215292"). */
export function cleanDescription(content: string, counterparty: string | null): string {
  let s = content.replace(/\s+/g, " ").trim();
  // Hóa đơn điện nước thanh toán qua VNPAY/ví: giữ mã khách hàng để biết đồng hồ của cơ sở nào
  const bill = s.match(/BILL\s+ELECTRIC\s+(\d{6,})/i) ?? s.match(/\bWATER\s+(\d{6,})/i);
  if (bill) return `${/ELECTRIC/i.test(bill[0]) ? "Tiền điện" : "Tiền nước"} mã ${bill[1]}`;
  s = s.replace(/^MBCT\s+/i, "");
  // Mã tham chiếu MB ở cuối: "D2 6IRE2Z/377829", "DL29XJJA/955 391" (ngân hàng chèn khoảng trắng ngẫu nhiên)
  s = s.replace(/\s+D\s?[0-9A-Z]{1,3}\s?[0-9A-Z ]{2,10}\/[\d ]+$/i, "");
  s = s.replace(/\s*-\s*Ma giao\s*dich.*$/i, "");
  s = s.replace(/\s{2,}/g, " ").replace(/[-\s]+$/, "").trim();
  if (counterparty && !fold(s).includes(fold(counterparty))) s = `${s} · ${titleCase(counterparty)}`;
  return s.slice(0, 200);
}

function titleCase(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Tháng hạch toán = tháng trả tiền (ngày hạch toán trên sao kê). Lương t9 trả đầu tháng 10 → tháng 10. */
export function guessMonth(bookedOn: string): string {
  return bookedOn.slice(0, 7);
}

export function classifyTransaction(
  t: { content: string; counterparty: string | null; bookedOn: string },
  ctx: ClassifyContext,
): Suggestion {
  const hints: string[] = [];
  const text = fold(t.content).replace(/[^a-z0-9]+/g, " ").replace(NOISE, " ").replace(/\s+/g, " ").trim();
  const tokens = new Set(text.split(" "));

  // Cơ sở
  let propertyId: Suggestion["propertyId"] = undefined;
  const hits = ctx.properties.filter((p) => p.codes.some((c) => tokens.has(c)));
  const common = tokens.has(COMMON_CODE);
  if (hits.length === 1 && !common) {
    propertyId = hits[0].id;
    hints.push(`mã "${hits[0].codes.find((c) => tokens.has(c))}"`);
  } else if (!hits.length && common) {
    propertyId = null;
    hints.push('"coso" → chi phí chung');
  } else if (hits.length + (common ? 1 : 0) > 1) {
    hints.push("nội dung có nhiều mã cơ sở, chọn tay");
  } else if (ctx.history?.length) {
    // Không có mã: dùng mã khách hàng / số hợp đồng dài (hóa đơn điện nước) đã từng ghi nhận cho một cơ sở
    const nums = new Set(t.content.match(/\b\d{8,}\b/g) ?? []);
    const seen = new Set<string | null>();
    for (const h of ctx.history) if ((h.content.match(/\b\d{8,}\b/g) ?? []).some((n) => nums.has(n))) seen.add(h.propertyId);
    if (seen.size === 1) {
      propertyId = [...seen][0];
      hints.push("cùng mã khách hàng với lần chi trước");
    }
  }

  // Loại chi phí
  const byName = new Map(ctx.categories.map((c) => [fold(c.name), c.id]));
  let categoryId: string | undefined;
  let byRule = false;
  for (const [re, names] of RULES) {
    if (!re.test(text)) continue;
    const id = names.map((n) => byName.get(fold(n))).find(Boolean);
    if (id) {
      categoryId = id;
      byRule = true;
      hints.push(`từ khóa "${text.match(re)?.[0]}"`);
      break;
    }
  }
  if (!categoryId && t.counterparty && ctx.history?.length) {
    const key = fold(t.counterparty);
    const counts = new Map<string, number>();
    for (const h of ctx.history) if (h.counterparty && fold(h.counterparty) === key) counts.set(h.categoryId, (counts.get(h.categoryId) ?? 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best && ctx.categories.some((c) => c.id === best[0])) {
      categoryId = best[0];
      hints.push("theo lần chi trước cho cùng người nhận");
    }
  }

  const month = guessMonth(t.bookedOn);

  const propertyByCode = propertyId !== undefined && !hints.includes("cùng mã khách hàng với lần chi trước");
  return { propertyId, categoryId, month, description: cleanDescription(t.content, t.counterparty), hints, confident: propertyByCode && byRule };
}

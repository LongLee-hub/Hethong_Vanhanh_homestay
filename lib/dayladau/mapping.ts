// Map một order Dayladau sang Booking. Thuần TypeScript (không phụ thuộc Node) để dùng chung
// cho máy chủ và bản chạy thử. Trường dữ liệu lấy theo script Apps Script đang chạy của LOCI.

export type RawOrder = Record<string, any>;

export interface MappedBooking {
  externalId: string;
  /** Khóa listing để gắn với phòng: listing.id nếu có, không thì tên listing. */
  listingKey: string;
  listingName: string;
  channel: string;
  guestName: string | null;
  bookedAt: string | null;
  checkIn: string;
  checkOut: string;
  rentalType: string | null;
  grossAmount: number; // total_billed
  hostAmount: number; // "Amount host" = Σ item.amount × tỷ lệ host
  commissionAmount: number; // gross − hostAmount
  status: "CONFIRMED" | "CANCELLED";
  rawStatus: string;
}

/** Ngày giờ → ngày lịch Việt Nam "YYYY-MM-DD". Nhận ISO, "dd/mm/yyyy", Unix giây hoặc mili-giây. */
export function toVNDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d{9,13}$/.test(String(v))) {
    const n = Number(v);
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms + 7 * 3600_000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  // Có giờ nhưng không có múi giờ: coi là giờ Việt Nam
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(+d) ? null : new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

function addDay(d: string): string {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Giống getTotalHostAmountFromOrder trong script: Σ item.amount × rate của commission_rates type 'host'. */
export function hostAmountOf(order: RawOrder): number {
  if (!Array.isArray(order?.items)) return 0;
  let total = 0;
  for (const item of order.items) {
    const host = Array.isArray(item?.commission_rates) ? item.commission_rates.find((r: any) => r?.type === "host") : null;
    let rate = num(host?.rate);
    if (rate > 1) rate = rate / 100; // phòng khi API trả dạng phần trăm (85 thay vì 0.85)
    total += num(item?.amount) * rate;
  }
  return Math.round(total);
}

// TODO(CONFIRM): danh sách trạng thái Dayladau được coi là hủy. Màn hình "Kiểm tra kết nối" liệt kê
// mọi trạng thái đang có để anh xác nhận.
export const CANCELLED_STATUS = /cancel|refund|reject|declin|expire|fail|void|hủy|huy/i;

export function mapDayladauOrder(o: RawOrder): MappedBooking {
  const externalId = String(o?.id ?? "").trim();
  const checkIn = toVNDate(o?.reservation?.start_time);
  let checkOut = toVNDate(o?.reservation?.end_time);
  if (!externalId) throw new Error("Đơn Dayladau không có id");
  if (!checkIn || !checkOut) throw new Error(`Đơn ${externalId}: thiếu ngày nhận hoặc trả phòng`);
  // Thuê theo giờ / trong ngày: ghi nhận là 1 đêm vào ngày nhận phòng. TODO(CONFIRM)
  if (checkOut <= checkIn) checkOut = addDay(checkIn);

  const listingName = String(o?.listing?.name ?? "").trim();
  const listingId = o?.listing?.id ?? o?.listing_id;
  const gross = Math.round(num(o?.total_billed));
  const hostAmount = hostAmountOf(o);
  const rawStatus = String(o?.status ?? "");
  const ch = String(o?.channel ?? o?.source ?? o?.ota ?? "").trim();
  return {
    externalId,
    listingKey: listingId !== undefined && listingId !== null && listingId !== "" ? String(listingId) : listingName,
    listingName: listingName || "không rõ",
    channel: ch ? ch.replace(/^\w/, (c) => c.toUpperCase()) : "Dayladau",
    guestName: o?.guest?.fullname ? String(o.guest.fullname) : null,
    bookedAt: toVNDate(o?.created_at ?? o?.createdAt ?? o?.booked_at),
    checkIn,
    checkOut,
    rentalType: o?.reservation?.subtotal_detail_v2?.type_rental ?? null,
    grossAmount: gross,
    hostAmount,
    // Không có items/commission_rates (hostAmount = 0 mà gross > 0) → để null hoa hồng, nơi gọi dùng tỷ lệ cấu hình
    commissionAmount: hostAmount > 0 ? Math.max(0, gross - hostAmount) : 0,
    status: CANCELLED_STATUS.test(rawStatus) ? "CANCELLED" : "CONFIRMED",
    rawStatus,
  };
}

/**
 * Doanh thu net ghi nhận: tiền host nhận.
 * Đơn hủy: phí hủy = host_amount (Dayladau ghi tiền hoàn bằng item reservation âm), không có thì 0.
 */
export function netOf(m: MappedBooking, fallbackCommissionPct = 0): { commission: number; net: number } {
  if (m.status === "CANCELLED") return m.hostAmount > 0 ? { commission: Math.max(0, m.grossAmount - m.hostAmount), net: m.hostAmount } : { commission: 0, net: 0 };
  if (m.hostAmount > 0) return { commission: m.grossAmount - m.hostAmount, net: m.hostAmount };
  const commission = Math.round((m.grossAmount * fallbackCommissionPct) / 100);
  return { commission, net: m.grossAmount - commission };
}

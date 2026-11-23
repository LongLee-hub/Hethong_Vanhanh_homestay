// Đơn tạo tay trên lịch Dayladau (thẻ "Host" ở trang Đơn của host.dayladau.com, mã "cal…"): khách gia hạn giờ,
// khách quen, đặt qua Zalo, khóa phòng… Các đơn này KHÔNG có trong /v1/hosts/{id}/orders, nên đọc riêng:
//   GET https://api.dayladau.com/v2/calendars/search?host_id=&type=reservation&start_time=&end_time=&offset=&limit=&x_access_token=
// (thời gian tính bằng mili-giây, giống trang host). Host nhận đủ số tiền của đơn, không có phí kênh bán.
//
// Dạng dữ liệu đọc theo nhiều tên trường có thể có; "Kiểm tra kết nối" hiện tên trường thật để đối chiếu.
import { DAYLADAU_BASE, redact, withRetry } from "./client";
import { CANCELLED_STATUS, toInstant, toVNDate, type MappedBooking, type RawOrder } from "./mapping";

export const CALENDAR_PAGE_SIZE = 50;
const MAX_PAGES = 100;

export function calendarUrl(hostId: string, token: string, fromMs: number, toMs: number, offset: number, limit = CALENDAR_PAGE_SIZE): string {
  const u = new URL(`${DAYLADAU_BASE}/v2/calendars/search`);
  u.searchParams.set("start_time", String(fromMs));
  u.searchParams.set("end_time", String(toMs));
  u.searchParams.set("host_id", hostId);
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("type", "reservation");
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("x_access_token", token);
  return u.toString();
}

/** Danh sách trong phản hồi: mảng trực tiếp hoặc nằm dưới một khóa quen thuộc. */
export function itemsOf(data: unknown): RawOrder[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  for (const k of ["calendars", "data", "items", "reservations", "results", "rows", "list"]) {
    const v = d[k];
    if (Array.isArray(v)) return v as RawOrder[];
    if (v && typeof v === "object") {
      const inner = itemsOf(v);
      if (inner) return inner;
    }
  }
  return null;
}

export type CalendarFetch = (hostId: string, token: string, fromMs: number, toMs: number, offset: number) => Promise<RawOrder[]>;

export const fetchCalendarPage: CalendarFetch = (hostId, token, fromMs, toMs, offset) =>
  withRetry(async () => {
    let r: Response;
    try {
      r = await fetch(calendarUrl(hostId, token, fromMs, toMs, offset), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(redact(`Không kết nối được Dayladau (lịch): ${(e as Error).message}`, token));
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Host ID hoặc access token không hợp lệ (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`Dayladau trả lỗi HTTP ${r.status} khi lấy đơn trên lịch`);
    const items = itemsOf(await r.json());
    if (!items) throw new Error("Phản hồi lịch Dayladau không có danh sách đơn");
    return items;
  });

/** Mọi đơn trên lịch trong khoảng thời gian, gộp các trang và bỏ trùng theo id. */
export async function listCalendarReservations(hostId: string, token: string, fromMs: number, toMs: number, fetchPage: CalendarFetch = fetchCalendarPage): Promise<RawOrder[]> {
  const byId = new Map<string, RawOrder>();
  for (let p = 0; p < MAX_PAGES; p++) {
    const page = await fetchPage(hostId, token, fromMs, toMs, p * CALENDAR_PAGE_SIZE);
    const before = byId.size;
    for (const o of page) byId.set(String(o?.id ?? o?._id ?? o?.code ?? `#${byId.size}`), o);
    // Hết trang, hoặc API bỏ qua offset (trang không thêm đơn mới)
    if (page.length < CALENDAR_PAGE_SIZE || byId.size === before) break;
  }
  return [...byId.values()];
}

const num = (v: unknown) => {
  if (typeof v === "string") {
    // "1.225.000", "59,000đ": dấu chấm/phẩy là phân cách hàng nghìn
    const t = /\d[.,]\d{3}(\D|$)/.test(v) ? v.replace(/[^\d-]/g, "") : v.replace(/[^\d.-]/g, "");
    return t ? Number(t) : NaN;
  }
  const n = Number(v);
  return v !== null && v !== undefined && Number.isFinite(n) ? n : NaN;
};
const first = (...vs: unknown[]) => vs.find((v) => v !== undefined && v !== null && v !== "");

/** Tổng tiền khách phải trả cho đơn trên lịch ("PHẢI THANH TOÁN"), host nhận đủ. */
export function calendarAmountOf(o: RawOrder): number {
  const cands = [
    o?.total_billed, o?.total_price, o?.total_amount, o?.totalPrice, o?.total, o?.amount, o?.price, o?.payment_amount, o?.host_amount, o?.payout_amount,
    o?.reservation?.total_billed, o?.reservation?.total_price, o?.reservation?.total, o?.reservation?.price,
    o?.order?.total_billed, o?.data?.total_billed, o?.data?.price, o?.data?.total,
  ];
  for (const c of cands) {
    const n = num(c);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return 0;
}

const CHANNEL_NAMES: Record<string, string> = { zalo: "Zalo", direct: "Direct", dayladau: "Dayladau", "khach_quen": "Khách quen", "khách quen": "Khách quen", regular: "Khách quen" };

export interface MappedCalendarBooking extends MappedBooking {
  /** Đơn lịch sinh ra từ một đơn Dayladau (đã có trong /orders): không nhập lại để khỏi tính hai lần. */
  linkedOrderId: string | null;
}

/** Map một đơn trên lịch sang dạng đơn chung. Ném lỗi nếu thiếu id hoặc ngày. */
export function mapCalendarReservation(o: RawOrder): MappedCalendarBooking {
  const rawId = String(first(o?.id, o?._id, o?.code, o?.calendar_id) ?? "").trim();
  if (!rawId) throw new Error("Đơn trên lịch không có id");
  const externalId = rawId.startsWith("cal") ? rawId : `cal:${rawId}`;
  const startRaw = first(o?.start_time, o?.startTime, o?.start, o?.check_in, o?.checkin, o?.from, o?.reservation?.start_time, o?.data?.start_time);
  const endRaw = first(o?.end_time, o?.endTime, o?.end, o?.check_out, o?.checkout, o?.to, o?.reservation?.end_time, o?.data?.end_time);
  const checkIn = toVNDate(startRaw);
  let checkOut = toVNDate(endRaw);
  if (!checkIn || !checkOut) throw new Error(`Đơn lịch ${rawId}: thiếu ngày nhận hoặc trả phòng`);
  // Nhận và trả trong cùng một ngày: thuê giờ (không tính vào công suất), ghi vào ngày nhận phòng
  const sameDay = checkOut <= checkIn;
  if (sameDay) {
    const d = new Date(`${checkIn}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    checkOut = d.toISOString().slice(0, 10);
  }
  const listing = o?.listing ?? o?.room ?? o?.data?.listing;
  const listingId = first(listing?.id, listing?._id, o?.listing_id, o?.listingId, o?.room_id, o?.data?.listing_id);
  const listingName = String(first(listing?.name, listing?.title, listing?.nickname, o?.listing_name, o?.room_name) ?? "").trim();
  const rawStatus = String(first(o?.status, o?.reservation_status, o?.state, o?.reservation?.status) ?? "");
  const chRaw = String(first(o?.source, o?.channel, o?.sale_channel, o?.platform, o?.ota, o?.reservation?.source) ?? "").trim();
  const ch = CHANNEL_NAMES[chRaw.toLowerCase()] ?? (chRaw ? chRaw.charAt(0).toUpperCase() + chRaw.slice(1).toLowerCase() : "Dayladau");
  const guest = first(o?.guest?.fullname, o?.guest?.name, o?.guest_name, o?.customer_name, o?.customer?.name, o?.name, o?.title, o?.note_title);
  const amount = calendarAmountOf(o);
  const linked = first(o?.order_id, o?.orderId, o?.order?.id, o?.reservation?.order_id);
  return {
    externalId,
    listingKey: listingId !== undefined ? String(listingId) : listingName,
    listingName: listingName || "không rõ",
    channel: ch,
    guestName: guest ? String(guest) : null,
    bookedAt: toVNDate(first(o?.created_at, o?.createdAt)),
    checkIn,
    checkOut,
    checkInAt: toInstant(startRaw),
    checkOutAt: toInstant(endRaw),
    rentalType: sameDay ? "hourly_rental" : null,
    grossAmount: amount,
    hostAmount: amount,
    commissionAmount: 0,
    status: CANCELLED_STATUS.test(rawStatus) ? "CANCELLED" : "CONFIRMED",
    rawStatus,
    linkedOrderId: linked !== undefined ? String(linked) : null,
  };
}

/** Tên trường của một đơn lịch (không lấy giá trị), để kiểm tra cách đọc dữ liệu. */
export function fieldNamesOf(o: RawOrder, depth = 1): string[] {
  if (!o || typeof o !== "object") return [];
  return Object.entries(o).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v) && depth > 0 ? [k, ...fieldNamesOf(v as RawOrder, depth - 1).map((c) => `${k}.${c}`)] : [k],
  );
}

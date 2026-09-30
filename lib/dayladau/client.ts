// Client API Dayladau, theo script Apps Script đang chạy của LOCI:
//   GET https://api.dayladau.com/v1/hosts/{host_id}/orders?offset=&limit=&x_access_token=
//   Trả về { orders: [...] }, phân trang bằng offset/limit (100 đơn/trang).

export interface DayladauRawBooking {
  [k: string]: unknown;
}

export interface DayladauClient {
  /** Trả toàn bộ đơn của host, đã gộp các trang và bỏ trùng theo id. */
  listBookings(opts: { hostId: string; token: string; checkOutFrom?: string; maxOrders?: number }): Promise<DayladauRawBooking[]>;
}

export const DAYLADAU_BASE = process.env.DAYLADAU_API_BASE ?? "https://api.dayladau.com";
export const PAGE_SIZE = 100;

export function ordersUrl(hostId: string, token: string, offset: number, limit = PAGE_SIZE): string {
  const u = new URL(`${DAYLADAU_BASE}/v1/hosts/${encodeURIComponent(hostId)}/orders`);
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("x_access_token", token);
  return u.toString();
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if ((e as Error).message.includes("không hợp lệ")) break; // sai token: thử lại vô ích
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  throw last;
}

/** Không bao giờ để token lọt vào thông báo lỗi hay log. */
const redact = (s: string, token: string) => (token ? s.split(token).join("***") : s);

export async function fetchOrdersPage(hostId: string, token: string, offset: number, limit = PAGE_SIZE): Promise<DayladauRawBooking[]> {
  return withRetry(async () => {
    let r: Response;
    try {
      r = await fetch(ordersUrl(hostId, token, offset, limit), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(redact(`Không kết nối được Dayladau: ${(e as Error).message}`, token));
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Host ID hoặc access token không hợp lệ (HTTP ${r.status})`);
    if (r.status === 404) throw new Error("Không tìm thấy host này trên Dayladau (HTTP 404). Kiểm tra lại host ID.");
    if (!r.ok) throw new Error(`Dayladau trả lỗi HTTP ${r.status}`);
    const data = (await r.json()) as { orders?: DayladauRawBooking[] };
    if (!Array.isArray(data.orders)) throw new Error("Phản hồi Dayladau không có danh sách orders");
    return data.orders;
  });
}

export const httpDayladauClient: DayladauClient = {
  async listBookings({ hostId, token, maxOrders = 5000 }) {
    const byId = new Map<string, DayladauRawBooking>();
    for (let offset = 0; offset < maxOrders; offset += PAGE_SIZE) {
      const orders = await fetchOrdersPage(hostId, token, offset);
      // Bỏ trùng theo id: đơn có thể xuất hiện ở hai trang khi dữ liệu thay đổi giữa hai lần gọi
      for (const o of orders) byId.set(String(o.id), o);
      if (orders.length < PAGE_SIZE) break;
    }
    return [...byId.values()];
  },
};

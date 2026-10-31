// Cập nhật đơn trong hệ thống từ dữ liệu đơn mới nhất mà đồng bộ phiếu thanh toán đã tải về.
//
// Vì sao cần: đồng bộ đơn hằng đêm chỉ đọc 300 đơn mới tạo nhất (API trả theo ngày tạo), nên đơn đặt từ lâu
// rồi mới bị sửa trên Dayladau (gia hạn, thêm dòng giảm giá, đổi ngày, đơn của listing gắn phòng muộn) không bao giờ
// được đọc lại: hệ thống giữ tiền cũ và phiếu thanh toán báo "Lệch tiền" / "Chưa có trong hệ thống".
// Đồng bộ phiếu đã có bản mới nhất của mọi đơn trong phiếu và mọi đơn chờ trả (/v1/orders?version=2), nên dùng luôn.
//
// Đơn version=2 khác đơn ở /v1/hosts/{id}/orders ở chỗ `status` là trạng thái thanh toán ("paid"); trạng thái đặt phòng
// nằm ở `reservation.status`. Chỉ ghi khi tiền host tính theo cách map hiện tại trùng với tiền Dayladau trả cho đơn,
// để chắc chắn dữ liệu được hiểu đúng; không trùng thì để nguyên cho người kiểm tra.
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { bookings, properties } from "../db/schema";
import { getAllSettings } from "../services/settings";
import { upsertBooking, type BookingInput } from "../services/bookings";
import { mapDayladauOrder, netOf, type RawOrder } from "./mapping";
import { listingRef, roomsByListing } from "./room-listings";
import { backfillRoomOpenedOn } from "./room-opened";

export interface OrderRefreshSummary {
  created: number;
  updated: number;
  unchanged: number;
  /** Listing chưa gắn phòng, thiếu dữ liệu, hoặc tiền tính ra khác tiền Dayladau trả. */
  skipped: number;
  adjustments: number;
}

/** Tiền Dayladau trả host cho đơn (payout_amount, chưa có thì Σ items.host_amount); null nếu đơn không có số này. */
function dayladauHostAmount(o: RawOrder): number | null {
  const p = Number(o?.payout_amount);
  if (Number.isFinite(p) && p !== 0) return Math.round(p);
  if (Array.isArray(o?.items) && o.items.some((it: any) => it?.host_amount !== undefined && it?.host_amount !== null)) {
    return Math.round(o.items.reduce((s: number, it: any) => s + (Number(it?.host_amount) || 0), 0));
  }
  return null;
}

/** Đơn version=2 → dạng mapDayladauOrder hiểu: trạng thái đặt phòng thay cho trạng thái thanh toán. */
export function asBookingOrder(o: RawOrder): RawOrder {
  const st = o?.reservation?.status;
  return st !== undefined && st !== null && st !== "" ? { ...o, status: st } : o;
}

export async function refreshBookingsFromOrders(db: DB, accountId: string, raws: RawOrder[]): Promise<OrderRefreshSummary> {
  const sum: OrderRefreshSummary = { created: 0, updated: 0, unchanged: 0, skipped: 0, adjustments: 0 };
  const list = [...new Map(raws.filter((o) => o?.id !== undefined && o?.id !== null).map((o) => [String(o.id), o])).values()];
  if (!list.length) return sum;

  const pids = (await db.select({ id: properties.id }).from(properties).where(eq(properties.dayladauAccountId, accountId))).map((p) => p.id);
  const byListing = await roomsByListing(db, [accountId]);
  const roomOf = (key: string) => {
    const r = byListing.get(listingRef(accountId, key));
    return r && pids.includes(r.propertyId) ? r : undefined;
  };
  const cfg = await getAllSettings(db);

  const existing = new Map<string, typeof bookings.$inferSelect>();
  const ids = list.map((o) => String(o.id));
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db.select().from(bookings).where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.externalId, ids.slice(i, i + 500))));
    for (const r of rows) existing.set(r.externalId!, r);
  }

  for (const raw of list) {
    let m;
    try {
      m = mapDayladauOrder(asBookingOrder(raw));
    } catch {
      sum.skipped++;
      continue;
    }
    const prev = existing.get(m.externalId);
    const { commission, net } = netOf(m, Number(cfg[`commission.${prev?.channel ?? m.channel}`] ?? 0));
    const paid = dayladauHostAmount(raw);
    if (paid === null || Math.abs(paid - net) > 1) {
      sum.skipped++;
      continue;
    }
    const room = roomOf(m.listingKey) ?? roomOf(m.listingName);

    let input: BookingInput;
    if (prev) {
      // Chỉ sửa ngày, tiền và trạng thái; kênh, loại thuê và dữ liệu gốc giữ như đồng bộ đơn đã ghi
      input = {
        source: "DAYLADAU", externalId: m.externalId, channel: prev.channel,
        propertyId: room?.propertyId ?? prev.propertyId, roomId: room?.id ?? prev.roomId,
        checkIn: m.checkIn, checkOut: m.checkOut, grossAmount: m.grossAmount, commissionAmount: commission, netAmount: net,
        status: m.status, rentalType: m.rentalType ?? prev.rentalType, guestName: m.guestName ?? prev.guestName, lastSyncedAt: new Date(),
      };
    } else {
      if (!room) {
        sum.skipped++;
        continue;
      }
      input = {
        source: "DAYLADAU", externalId: m.externalId, propertyId: room.propertyId, roomId: room.id, channel: m.channel, guestName: m.guestName,
        bookedAt: m.bookedAt, checkIn: m.checkIn, checkOut: m.checkOut, grossAmount: m.grossAmount, commissionAmount: commission,
        netAmount: net, status: m.status, rentalType: m.rentalType, rawPayload: raw, lastSyncedAt: new Date(),
      };
    }
    const r = await upsertBooking(db, input, "SYNC", "Cập nhật theo phiếu thanh toán Dayladau");
    sum[r.action]++;
    sum.adjustments += r.adjustments.length;
  }
  if (sum.created) await backfillRoomOpenedOn(db, pids);
  return sum;
}

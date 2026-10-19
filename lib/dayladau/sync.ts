// Job đồng bộ Dayladau (Đặc tả mục 6). Chạy 06:00 hằng ngày và khi Admin bấm "Đồng bộ ngay".
import { and, eq, gte, inArray, isNotNull, notInArray } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { alerts, bookings, investors, properties, rooms, syncRuns } from "../db/schema";
import { decryptSecret, getAllSettings, notifyLark } from "../services/settings";
import { upsertBooking } from "../services/bookings";
import { httpDayladauClient, type DayladauClient } from "./client";
import { mapDayladauOrder, netOf } from "./mapping";

export interface SyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  adjustments: number;
  errors: { investorId: string; message: string }[];
}

/** Mỗi lần đồng bộ chỉ lấy chừng này đơn mới nhất của mỗi NĐT (API trả đơn mới tạo trước). */
export const SYNC_MAX_ORDERS = 300;
/** Lần đồng bộ đầu của NĐT (chưa có đơn nào trong hệ thống) hoặc khi Admin bấm "Lấy toàn bộ đơn cũ": lấy hết lịch sử. */
export const SYNC_FULL_MAX_ORDERS = 5000;

async function raiseAlert(db: DB, type: string, key: string, message: string, propertyId?: string) {
  await db.insert(alerts).values({ type, key, message, propertyId: propertyId ?? null }).onConflictDoNothing();
}

export async function syncBookings(
  db: DB,
  opts: { client?: DayladauClient; today?: string; decrypt?: (s: string) => string; investorIds?: string[]; maxOrders?: number; full?: boolean } = {},
): Promise<SyncSummary> {
  const client = opts.client ?? httpDayladauClient;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const cfg = await getAllSettings(db);
  const [run] = await db.insert(syncRuns).values({}).returning();
  const sum: SyncSummary = { created: 0, updated: 0, unchanged: 0, skipped: 0, adjustments: 0, errors: [] };

  const conds = [isNotNull(investors.dayladauHostId), isNotNull(investors.dayladauTokenEncrypted)];
  if (opts.investorIds?.length) conds.push(inArray(investors.id, opts.investorIds));
  const invs = await db.select().from(investors).where(and(...conds));
  const allRooms = await db.select().from(rooms);

  for (const inv of invs) {
    try {
      const props = await db.select().from(properties).where(eq(properties.investorId, inv.id));
      const pids = props.map((p) => p.id);
      // Phòng của NĐT này, tra theo mã listing Dayladau (id hoặc tên listing)
      const roomByListing = new Map(allRooms.filter((r) => r.dayladauRoomId && pids.includes(r.propertyId)).map((r) => [r.dayladauRoomId!, r]));
      // NĐT mới (đã gắn phòng nhưng chưa có đơn nào về) thì lấy toàn bộ đơn cũ, các lần sau chỉ lấy đơn mới nhất
      const first = roomByListing.size > 0 && !(await db.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.propertyId, pids))).limit(1)).length;
      const maxOrders = opts.maxOrders ?? (opts.full || first ? SYNC_FULL_MAX_ORDERS : SYNC_MAX_ORDERS);
      const raws = await client.listBookings({ hostId: inv.dayladauHostId!, token: decrypt(inv.dayladauTokenEncrypted!), maxOrders });
      const seen: string[] = [];
      const unmapped = new Map<string, { name: string; count: number }>();

      for (const raw of raws) {
        let m;
        try {
          m = mapDayladauOrder(raw);
        } catch (e) {
          sum.skipped++;
          sum.errors.push({ investorId: inv.id, message: (e as Error).message });
          continue;
        }
        const room = roomByListing.get(m.listingKey) ?? roomByListing.get(m.listingName);
        if (!room) {
          sum.skipped++;
          const u = unmapped.get(m.listingKey) ?? { name: m.listingName, count: 0 };
          u.count++;
          unmapped.set(m.listingKey, u);
          continue;
        }
        seen.push(m.externalId);
        const { commission, net } = netOf(m, Number(cfg[`commission.${m.channel}`] ?? 0));
        const r = await upsertBooking(
          db,
          {
            source: "DAYLADAU", externalId: m.externalId, propertyId: room.propertyId, roomId: room.id, channel: m.channel, guestName: m.guestName,
            bookedAt: m.bookedAt, checkIn: m.checkIn, checkOut: m.checkOut, grossAmount: m.grossAmount, commissionAmount: commission,
            netAmount: net, status: m.status, rentalType: m.rentalType, rawPayload: raw, lastSyncedAt: new Date(),
          },
          "SYNC",
        );
        sum[r.action]++;
        sum.adjustments += r.adjustments.length;
      }

      for (const [key, u] of unmapped) {
        await raiseAlert(db, "UNMAPPED_ROOM", `UNMAPPED_ROOM:${inv.id}:${key}`, `${inv.name}: listing "${u.name}" (${u.count} đơn) chưa gắn với phòng nào. Vào trang Kết nối Dayladau để gắn.`);
      }

      // Đơn đã có nhưng không còn trả về từ API: không xóa, chỉ cảnh báo (chỉ xét đơn còn ở tương lai gần).
      // Chỉ kết luận được khi đã lấy hết đơn; chạm trần maxOrders thì đơn cũ vắng mặt là chuyện bình thường.
      if (pids.length && raws.length < maxOrders) {
        const missing = await db
          .select({ id: bookings.id, externalId: bookings.externalId, propertyId: bookings.propertyId })
          .from(bookings)
          .where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.propertyId, pids), gte(bookings.checkOut, D.firstDay(D.prevMonth(D.monthOf(today)))), eq(bookings.status, "CONFIRMED"), seen.length ? notInArray(bookings.externalId, seen) : undefined));
        for (const b of missing) {
          await raiseAlert(db, "BOOKING_MISSING", `BOOKING_MISSING:${b.id}`, `Đơn ${b.externalId} không còn trả về từ Dayladau. Kiểm tra lại trên Dayladau.`, b.propertyId);
        }
      }
    } catch (e) {
      const message = (e as Error).message;
      sum.errors.push({ investorId: inv.id, message });
      await raiseAlert(db, "SYNC_FAILED", `SYNC_FAILED:${inv.id}:${today}`, `Đồng bộ Dayladau lỗi cho ${inv.name}: ${message}`);
      await notifyLark(db, `Đồng bộ Dayladau lỗi cho ${inv.name}: ${message}`);
      // Lỗi của một NĐT không dừng các NĐT khác
    }
  }

  await db
    .update(syncRuns)
    .set({ finishedAt: new Date(), created: sum.created, updated: sum.updated, skipped: sum.skipped, errors: sum.errors })
    .where(eq(syncRuns.id, run.id));
  return sum;
}

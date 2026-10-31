// Job đồng bộ Dayladau (Đặc tả mục 6). Chạy 06:00 hằng ngày và khi Admin bấm "Đồng bộ ngay".
import { hostname } from "node:os";
import { and, eq, gt, gte, inArray, notInArray, sql } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { rowsOf } from "../db/rows";
import { alerts, bookings, dayladauAccounts, investors, properties, rooms, syncRuns } from "../db/schema";
import { decryptSecret, getAllSettings, notifyLark } from "../services/settings";
import { sameTracked, upsertBooking, type BookingInput } from "../services/bookings";
import { httpDayladauClient, type DayladauClient } from "./client";
import { mapDayladauOrder, netOf } from "./mapping";
import { listingRef, roomsByListing } from "./room-listings";
import { rematchDayladauPayoutItems } from "./payouts";

export interface SyncSummary {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  adjustments: number;
  /** Listing có đơn nhưng chưa gắn phòng trong lần đồng bộ này (đơn của chúng bị bỏ qua). */
  unmapped: { account: string; listing: string; count: number }[];
  errors: { accountId: string; investorId: string; message: string }[];
}

/** Mỗi lần đồng bộ chỉ lấy chừng này đơn mới nhất của mỗi tài khoản (API trả đơn mới tạo trước). */
export const SYNC_MAX_ORDERS = 300;
/** Lần đồng bộ đầu của tài khoản (chưa có đơn nào trong hệ thống), khi Admin bấm "Lấy toàn bộ đơn cũ" hoặc lấy đơn theo tháng: lấy hết lịch sử. */
export const SYNC_FULL_MAX_ORDERS = 5000;
// API không lọc được theo ngày và đơn của một tháng có thể được tạo từ rất lâu, nên đồng bộ theo tháng cũng phải đọc toàn bộ lịch sử.

/**
 * JSON để so dữ liệu gốc của đơn: khóa đã sắp xếp (jsonb không giữ thứ tự khóa), phần tử mảng cũng sắp xếp
 * (Dayladau trả items/bills theo thứ tự khác nhau giữa các lần gọi; cách map chỉ cộng tổng nên thứ tự không quan trọng).
 */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).sort().join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** Nơi chạy đồng bộ, ghi kèm cảnh báo lỗi: biết ngay lỗi do Vercel hay do một máy khác (máy tính, VPS cũ) đang trỏ vào DB thật. */
function runOrigin(): string {
  if (process.env.VERCEL) return "Vercel";
  try {
    return `máy ${hostname()}`;
  } catch {
    return "máy không rõ";
  }
}

const CHUNK = 500;
const chunks = <T>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) => xs.slice(i * CHUNK, (i + 1) * CHUNK));

/**
 * Ngày mở bán của phòng không được muộn hơn đơn đầu tiên của phòng. Phòng tạo lại hoặc gắn listing sau khi đã có đơn
 * (ngày mở bán mặc định là hôm tạo) sẽ có đêm đã bán nhiều hơn đêm có thể bán: tỷ lệ kín phòng vượt 100% và doanh thu dự kiến
 * bị nhân lên. Kéo ngày mở bán về ngày nhận phòng sớm nhất của đơn đã xác nhận.
 */
export async function backfillRoomOpenedOn(db: DB, propertyIds: string[]): Promise<number> {
  if (!propertyIds.length) return 0;
  // Một câu UPDATE cho mọi phòng (trước đây một câu cho mỗi phòng)
  const fixed = await db.execute(sql`
    update ${rooms} set opened_on = f.first
    from (
      select ${bookings.roomId} as room_id, min(${bookings.checkIn}) as first from ${bookings}
      where ${and(inArray(bookings.propertyId, propertyIds), eq(bookings.status, "CONFIRMED"))}
      group by ${bookings.roomId}
    ) f
    where ${rooms.id} = f.room_id and ${rooms.openedOn} > f.first
    returning ${rooms.id}`);
  return rowsOf(fixed).length;
}

async function raiseAlert(db: DB, type: string, key: string, message: string, propertyId?: string) {
  await db.insert(alerts).values({ type, key, message, propertyId: propertyId ?? null }).onConflictDoNothing();
}

export async function syncBookings(
  db: DB,
  opts: { client?: DayladauClient; today?: string; decrypt?: (s: string) => string; investorIds?: string[]; accountIds?: string[]; maxOrders?: number; full?: boolean; month?: string } = {},
): Promise<SyncSummary> {
  const client = opts.client ?? httpDayladauClient;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const cfg = await getAllSettings(db);
  const [run] = await db.insert(syncRuns).values({}).returning();
  const sum: SyncSummary = { created: 0, updated: 0, unchanged: 0, skipped: 0, adjustments: 0, unmapped: [], errors: [] };

  // Gọi riêng từng tài khoản Dayladau đang bật; tài khoản chỉ đổ đơn vào các cơ sở đang dùng nó
  const conds = [eq(dayladauAccounts.active, true)];
  if (opts.investorIds?.length) conds.push(inArray(dayladauAccounts.investorId, opts.investorIds));
  if (opts.accountIds?.length) conds.push(inArray(dayladauAccounts.id, opts.accountIds));
  const accs = await db
    .select({ acc: dayladauAccounts, investorName: investors.name })
    .from(dayladauAccounts)
    .innerJoin(investors, eq(investors.id, dayladauAccounts.investorId))
    .where(and(...conds));
  const byListing = await roomsByListing(db, accs.map((a) => a.acc.id));

  for (const { acc, investorName } of accs) {
    const who = `${investorName} · ${acc.label}`;
    const errorsBefore = sum.errors.length;
    try {
      const props = await db.select().from(properties).where(eq(properties.dayladauAccountId, acc.id));
      const pids = props.map((p) => p.id);
      // Phòng của tài khoản này, tra theo mã listing Dayladau (id hoặc tên listing), gồm cả listing phụ của phòng
      const roomOf = (key: string) => { const r = byListing.get(listingRef(acc.id, key)); return r && pids.includes(r.propertyId) ? r : undefined; };
      const hasRooms = [...byListing.entries()].some(([k, r]) => k.startsWith(listingRef(acc.id, "")) && pids.includes(r.propertyId));
      // Tài khoản mới (đã gắn phòng nhưng chưa có đơn nào về) thì lấy toàn bộ đơn cũ, các lần sau chỉ lấy đơn mới nhất
      const first = hasRooms && !(await db.select({ id: bookings.id }).from(bookings).where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.propertyId, pids))).limit(1)).length;
      const maxOrders = opts.maxOrders ?? (opts.full || opts.month || first ? SYNC_FULL_MAX_ORDERS : SYNC_MAX_ORDERS);
      const raws = await client.listBookings({ hostId: acc.hostId, token: decrypt(acc.tokenEncrypted), maxOrders });
      const seen: string[] = [];
      const unmapped = new Map<string, { name: string; count: number }>();
      const todo: BookingInput[] = [];

      for (const raw of raws) {
        let m;
        try {
          m = mapDayladauOrder(raw);
        } catch (e) {
          sum.skipped++;
          sum.errors.push({ accountId: acc.id, investorId: acc.investorId, message: (e as Error).message });
          continue;
        }
        // Đồng bộ theo tháng: chỉ ghi đơn có đêm trong tháng (giống bookingsForMonth). Đơn ngoài tháng vẫn tính là đã thấy trên API.
        if (opts.month && !(m.checkIn <= D.lastDay(opts.month) && m.checkOut > D.firstDay(opts.month))) {
          seen.push(m.externalId);
          continue;
        }
        const room = roomOf(m.listingKey) ?? roomOf(m.listingName);
        if (!room) {
          sum.skipped++;
          const u = unmapped.get(m.listingKey) ?? { name: m.listingName, count: 0 };
          u.count++;
          unmapped.set(m.listingKey, u);
          continue;
        }
        seen.push(m.externalId);
        const { commission, net } = netOf(m, Number(cfg[`commission.${m.channel}`] ?? 0));
        todo.push({
          source: "DAYLADAU", externalId: m.externalId, propertyId: room.propertyId, roomId: room.id, channel: m.channel, guestName: m.guestName,
          bookedAt: m.bookedAt, checkIn: m.checkIn, checkOut: m.checkOut, grossAmount: m.grossAmount, commissionAmount: commission,
          netAmount: net, status: m.status, rentalType: m.rentalType, rawPayload: raw, lastSyncedAt: new Date(),
        });
      }

      // Đọc sẵn đơn đã có bằng vài truy vấn, chỉ mở transaction cho đơn mới hoặc có thay đổi.
      // Đơn y hệt lần trước (cả tên khách và dữ liệu gốc) chỉ cần cập nhật giờ đồng bộ, gộp thành từng lô.
      const existing = new Map<string, Pick<typeof bookings.$inferSelect, "id" | "roomId" | "checkIn" | "checkOut" | "grossAmount" | "commissionAmount" | "netAmount" | "status" | "rentalType" | "guestName" | "rawPayload">>();
      for (const ids of chunks(todo.map((b) => b.externalId!))) {
        const rows = await db
          .select({ id: bookings.id, externalId: bookings.externalId, roomId: bookings.roomId, checkIn: bookings.checkIn, checkOut: bookings.checkOut, grossAmount: bookings.grossAmount, commissionAmount: bookings.commissionAmount, netAmount: bookings.netAmount, status: bookings.status, rentalType: bookings.rentalType, guestName: bookings.guestName, rawPayload: bookings.rawPayload })
          .from(bookings)
          .where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.externalId, ids)));
        for (const { externalId, ...r } of rows) existing.set(externalId!, r);
      }
      const untouched: string[] = [];
      for (const input of todo) {
        const prev = existing.get(input.externalId!);
        const next = { ...input, rentalType: input.rentalType ?? null } as typeof bookings.$inferSelect;
        if (prev && sameTracked(prev, next) && prev.guestName === input.guestName && stableJson(prev.rawPayload) === stableJson(input.rawPayload)) {
          untouched.push(prev.id);
          sum.unchanged++;
          continue;
        }
        const r = await upsertBooking(db, input, "SYNC");
        sum[r.action]++;
        sum.adjustments += r.adjustments.length;
      }
      for (const ids of chunks(untouched)) await db.update(bookings).set({ lastSyncedAt: new Date() }).where(inArray(bookings.id, ids));
      await backfillRoomOpenedOn(db, pids);

      for (const [key, u] of unmapped) {
        sum.unmapped.push({ account: who, listing: u.name, count: u.count });
        await raiseAlert(db, "UNMAPPED_ROOM", `UNMAPPED_ROOM:${acc.id}:${key}`, `${who}: listing "${u.name}" (${u.count} đơn) chưa gắn với phòng nào. Vào trang Kết nối Dayladau để gắn.`);
      }

      // Đơn đã có nhưng không còn trả về từ API: không xóa, chỉ cảnh báo (chỉ xét đơn còn ở tương lai gần).
      // Chỉ xét cơ sở dùng tài khoản này: đơn của cơ sở dùng tài khoản khác không bao giờ có trong kết quả.
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
      await db.update(dayladauAccounts).set({ lastSyncedAt: new Date(), lastSyncStatus: "OK", lastSyncError: sum.errors[errorsBefore]?.message ?? null }).where(eq(dayladauAccounts.id, acc.id));
    } catch (e) {
      const message = (e as Error).message;
      sum.errors.push({ accountId: acc.id, investorId: acc.investorId, message });
      await db.update(dayladauAccounts).set({ lastSyncedAt: new Date(), lastSyncStatus: "FAILED", lastSyncError: message }).where(eq(dayladauAccounts.id, acc.id));
      const where = runOrigin();
      await raiseAlert(db, "SYNC_FAILED", `SYNC_FAILED:${acc.id}:${today}`, `Đồng bộ Dayladau lỗi cho ${who} (chạy trên ${where}): ${message}`);
      await notifyLark(db, `Đồng bộ Dayladau lỗi cho ${who} (chạy trên ${where}): ${message}`);
      // Lỗi của một tài khoản không dừng các tài khoản khác
    }
  }

  // Đơn mới về hoặc tiền đơn đổi: đối chiếu lại phiếu thanh toán Dayladau đã lưu (không gọi API)
  if (sum.created || sum.updated) await rematchDayladauPayoutItems(db, accs.map((a) => a.acc.id)).catch(() => 0);

  await db
    .update(syncRuns)
    .set({ finishedAt: new Date(), created: sum.created, updated: sum.updated, skipped: sum.skipped, errors: sum.errors })
    .where(eq(syncRuns.id, run.id));
  return sum;
}

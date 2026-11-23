// Job đồng bộ Dayladau (Đặc tả mục 6). Chạy 06:00 hằng ngày và khi Admin bấm "Đồng bộ ngay".
import { hostname } from "node:os";
import { and, eq, gt, gte, inArray, notInArray, notLike, sql } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { rowsOf } from "../db/rows";
import { alerts, bookings, dayladauAccounts, investors, properties, rooms, syncRuns } from "../db/schema";
import { decryptSecret, getAllSettings, notifyLark } from "../services/settings";
import { sameTracked, upsertBooking, type BookingInput } from "../services/bookings";
import { httpDayladauClient, type DayladauClient } from "./client";
import { mapDayladauOrder, netOf } from "./mapping";
import { mapCalendarReservation } from "./calendar";
import { ignoredListingRefs, listingRef, roomsByListing } from "./room-listings";
import { rematchDayladauPayoutItems } from "./payouts";
import { backfillRoomOpenedOn } from "./room-opened";

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

export { backfillRoomOpenedOn } from "./room-opened";

async function raiseAlert(db: DB, type: string, key: string, message: string, propertyId?: string) {
  await db.insert(alerts).values({ type, key, message, propertyId: propertyId ?? null }).onConflictDoNothing();
}

export async function syncBookings(
  db: DB,
  opts: {
    client?: DayladauClient; today?: string; decrypt?: (s: string) => string; investorIds?: string[]; accountIds?: string[]; maxOrders?: number; full?: boolean; month?: string;
    /** Chỉ ghi đơn của các listing này (mã hoặc tên), đọc toàn bộ lịch sử. Dùng khi vừa gắn listing vào phòng. */
    listingKeys?: string[];
  } = {},
): Promise<SyncSummary> {
  const client = opts.client ?? httpDayladauClient;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const cfg = await getAllSettings(db);
  const [run] = await db.insert(syncRuns).values({}).returning();
  const sum: SyncSummary = { created: 0, updated: 0, unchanged: 0, skipped: 0, adjustments: 0, unmapped: [], errors: [] };
  const onlyListings = opts.listingKeys?.length ? new Set(opts.listingKeys) : null;

  // Gọi riêng từng tài khoản Dayladau đang bật; tài khoản chỉ đổ đơn vào các cơ sở đang dùng nó
  const conds = [eq(dayladauAccounts.active, true), eq(dayladauAccounts.payoutOnly, false)];
  if (opts.investorIds?.length) conds.push(inArray(dayladauAccounts.investorId, opts.investorIds));
  if (opts.accountIds?.length) conds.push(inArray(dayladauAccounts.id, opts.accountIds));
  const accs = await db
    .select({ acc: dayladauAccounts, investorName: investors.name })
    .from(dayladauAccounts)
    .innerJoin(investors, eq(investors.id, dayladauAccounts.investorId))
    .where(and(...conds));
  const byListing = await roomsByListing(db, accs.map((a) => a.acc.id));
  const ignored = await ignoredListingRefs(db, accs.map((a) => a.acc.id));

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
      const maxOrders = opts.maxOrders ?? (opts.full || opts.month || onlyListings || first ? SYNC_FULL_MAX_ORDERS : SYNC_MAX_ORDERS);
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
        // Chỉ nhập đơn của listing vừa gắn: đơn của listing khác để nguyên, không tính bỏ qua
        if (onlyListings && !onlyListings.has(m.listingKey) && !onlyListings.has(m.listingName)) continue;
        // Đồng bộ theo tháng: chỉ ghi đơn có đêm trong tháng (giống bookingsForMonth). Đơn ngoài tháng vẫn tính là đã thấy trên API.
        if (opts.month && !(m.checkIn <= D.lastDay(opts.month) && m.checkOut > D.firstDay(opts.month))) {
          seen.push(m.externalId);
          continue;
        }
        const room = roomOf(m.listingKey) ?? roomOf(m.listingName);
        // Listing của phòng đã xóa: bỏ qua lặng lẽ, không báo "chưa gắn phòng"
        if (!room && (ignored.has(listingRef(acc.id, m.listingKey)) || ignored.has(listingRef(acc.id, m.listingName)))) continue;
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
          bookedAt: m.bookedAt, checkIn: m.checkIn, checkOut: m.checkOut, checkInAt: m.checkInAt, checkOutAt: m.checkOutAt, grossAmount: m.grossAmount, commissionAmount: commission,
          netAmount: net, status: m.status, rentalType: m.rentalType, rawPayload: raw, lastSyncedAt: new Date(),
        });
      }

      // Đơn tạo tay trên lịch (thẻ Host): không có trong /orders, đọc riêng. Lỗi ở đây không chặn đồng bộ đơn.
      let calendarOk = false;
      if (client.listCalendar) {
        try {
          const vnMs = (d: string) => Date.parse(`${d}T00:00:00+07:00`);
          const [fromDay, toDay] = opts.month
            ? [D.firstDay(opts.month), D.addDays(D.lastDay(opts.month), 1)]
            : opts.full || onlyListings || first
              ? ["2024-01-01", D.addDays(today, 365)]
              : [D.firstDay(D.prevMonth(D.monthOf(today))), D.addDays(today, 180)];
          const cal = await client.listCalendar({ hostId: acc.hostId, token: decrypt(acc.tokenEncrypted), fromMs: vnMs(fromDay), toMs: vnMs(toDay) });
          const candidates: BookingInput[] = [];
          for (const raw of cal) {
            let m;
            try {
              m = mapCalendarReservation(raw);
            } catch {
              continue;
            }
            if (m.linkedOrderId) continue; // đơn Dayladau thật, đã nhập từ /orders
            if (onlyListings && !onlyListings.has(m.listingKey) && !onlyListings.has(m.listingName)) continue;
            if (opts.month && !(m.checkIn <= D.lastDay(opts.month) && m.checkOut > D.firstDay(opts.month))) continue;
            const room = roomOf(m.listingKey) ?? roomOf(m.listingName);
            if (!room) continue; // đơn lịch của listing chưa gắn: bỏ qua, không báo (listing đã được báo qua đơn thường)
            seen.push(m.externalId);
            candidates.push({
              source: "DAYLADAU", externalId: m.externalId, propertyId: room.propertyId, roomId: room.id, channel: m.channel, guestName: m.guestName,
              bookedAt: m.bookedAt, checkIn: m.checkIn, checkOut: m.checkOut, checkInAt: m.checkInAt, checkOutAt: m.checkOutAt, grossAmount: m.grossAmount, commissionAmount: 0,
              netAmount: m.status === "CANCELLED" ? 0 : m.grossAmount, status: m.status, rentalType: m.rentalType, rawPayload: raw, lastSyncedAt: new Date(),
            });
          }
          // Chỉ ghi đơn có tiền (khóa phòng, đổi phòng 0đ không phải doanh thu, không tính vào công suất).
          // Đơn đã nhập trước đó mà nay hủy hoặc về 0đ thì vẫn cập nhật.
          const zero = candidates.filter((c) => c.status === "CANCELLED" || !c.grossAmount).map((c) => c.externalId!);
          const had = new Set<string>();
          for (const ids of chunks(zero)) {
            for (const r of await db.select({ e: bookings.externalId }).from(bookings).where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.externalId, ids)))) had.add(r.e!);
          }
          for (const c of candidates) {
            if ((c.status === "CANCELLED" || !c.grossAmount) && !had.has(c.externalId!)) continue;
            if (c.status === "CANCELLED" || !c.grossAmount) c.status = "CANCELLED";
            todo.push(c);
          }
          calendarOk = true;
        } catch (e) {
          sum.errors.push({ accountId: acc.id, investorId: acc.investorId, message: `Đơn trên lịch (thẻ Host): ${(e as Error).message}` });
        }
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
      if (pids.length && raws.length < maxOrders && !onlyListings) {
        const missing = await db
          .select({ id: bookings.id, externalId: bookings.externalId, propertyId: bookings.propertyId })
          .from(bookings)
          .where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.propertyId, pids), gte(bookings.checkOut, D.firstDay(D.prevMonth(D.monthOf(today)))), eq(bookings.status, "CONFIRMED"), seen.length ? notInArray(bookings.externalId, seen) : undefined, calendarOk ? undefined : notLike(bookings.externalId, "cal%")));
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

/**
 * Nhập toàn bộ đơn cũ của listing vừa gắn vào phòng. Đồng bộ thường chỉ đọc 300 đơn mới nhất, nên listing gắn muộn
 * (phòng mới tạo, listing đã ẩn trên Dayladau) sẽ không bao giờ có đơn cũ nếu không nhập riêng.
 */
export async function importListingOrders(db: DB, accountId: string, listingKeys: string[], opts: { client?: DayladauClient; decrypt?: (s: string) => string } = {}) {
  const keys = listingKeys.filter(Boolean);
  if (!accountId || !keys.length) return null;
  return syncBookings(db, { ...opts, accountIds: [accountId], listingKeys: keys });
}

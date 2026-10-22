// Doanh thu từ payout Airbnb cho đơn không có trong Dayladau: mỗi mã đặt phòng chưa khớp đơn nào, có listing đã gán phòng,
// được dựng thành một đơn nguồn AIRBNB_PAYOUT để đêm ở và doanh thu tính vào phòng đó như đơn thường (quyết toán, báo cáo, KPI).
// Tiền đơn = tổng VNĐ Airbnb đã chuyển cho mã đó sau thuế (mọi dòng, mọi email), cùng nghĩa "thực nhận" của đơn Dayladau.
// Chống tính trùng: mã đã khớp đơn Dayladau/đơn tay → hủy đơn payout; phòng đã có đơn khác trùng ngày → không dựng.
import { and, eq, gt, inArray, isNotNull, lt, ne } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { airbnbListingRooms, airbnbPayoutItems, airbnbPayouts, bookings, properties, rooms, settlements } from "../db/schema";
import { upsertBooking } from "../services/bookings";

export const PAYOUT_SOURCE = "AIRBNB_PAYOUT" as const;
export const payoutExternalId = (code: string) => `airbnb-payout:${code}`;

/** Khóa listing của một dòng payout: ID listing Airbnb, email không có ID thì dùng tên listing. */
export const listingKeyOf = (i: { listingId: string | null; listingName: string | null }): string | null => i.listingId?.trim() || i.listingName?.trim() || null;

export interface PayoutBookingSummary {
  created: number;
  updated: number;
  cancelled: number;
  /** Mã đã gán phòng nhưng không dựng được đơn, kèm lý do. */
  skipped: { confirmationCode: string; reason: string }[];
}

interface Wanted {
  code: string;
  roomId: string;
  propertyId: string;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  amount: number;
}

/** Dựng lại đơn từ payout cho các NĐT (mặc định: mọi NĐT có payout). Chạy sau khi đối soát payout. */
export async function syncPayoutBookings(db: DB, investorIds?: string[]): Promise<PayoutBookingSummary> {
  const sum: PayoutBookingSummary = { created: 0, updated: 0, cancelled: 0, skipped: [] };
  const invs = investorIds?.length
    ? investorIds
    : (await db.selectDistinct({ id: airbnbPayouts.investorId }).from(airbnbPayouts)).map((r) => r.id);
  for (const inv of invs) await syncInvestor(db, inv, sum);
  return sum;
}

async function syncInvestor(db: DB, investorId: string, sum: PayoutBookingSummary) {
  const roomRows = await db.select({ id: rooms.id, propertyId: rooms.propertyId }).from(rooms).innerJoin(properties, eq(properties.id, rooms.propertyId)).where(eq(properties.investorId, investorId));
  const propOfRoom = new Map(roomRows.map((r) => [r.id, r.propertyId]));
  const propIds = [...new Set(roomRows.map((r) => r.propertyId))];
  const [assigned, items, existing, locked] = await Promise.all([
    db.select().from(airbnbListingRooms).where(eq(airbnbListingRooms.investorId, investorId)),
    db
      .select({ i: airbnbPayoutItems, bookingSource: bookings.source })
      .from(airbnbPayoutItems)
      .innerJoin(airbnbPayouts, eq(airbnbPayouts.id, airbnbPayoutItems.payoutId))
      .leftJoin(bookings, eq(bookings.id, airbnbPayoutItems.bookingId))
      .where(and(eq(airbnbPayouts.investorId, investorId), eq(airbnbPayouts.currency, "VND"), isNotNull(airbnbPayoutItems.confirmationCode))),
    propIds.length ? db.select().from(bookings).where(and(eq(bookings.source, PAYOUT_SOURCE), inArray(bookings.propertyId, propIds))) : Promise.resolve([]),
    db.select({ month: settlements.month }).from(settlements).where(and(eq(settlements.investorId, investorId), eq(settlements.status, "LOCKED"))),
  ]);
  const roomOfListing = new Map(assigned.map((a) => [a.listingKey, a.roomId]));
  const lockedMonths = new Set(locked.map((l) => l.month));

  // Gộp dòng theo mã đặt phòng (mọi email)
  const byCode = new Map<string, (typeof items)[number][]>();
  for (const r of items) {
    const code = r.i.confirmationCode!;
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code)!.push(r);
  }

  const wanted = new Map<string, Wanted>();
  for (const [code, rows] of byCode) {
    // Đã khớp đơn thật (Dayladau hoặc đơn tay): doanh thu đã có ở đơn đó
    if (rows.some((r) => r.i.bookingId && r.bookingSource !== PAYOUT_SOURCE)) continue;
    const roomId = rows.map((r) => listingKeyOf(r.i)).map((k) => (k ? roomOfListing.get(k) : undefined)).find((x) => x);
    if (!roomId) continue; // chưa gán phòng
    const propertyId = propOfRoom.get(roomId);
    if (!propertyId) { sum.skipped.push({ confirmationCode: code, reason: "Phòng đã gán không thuộc nhà đầu tư này" }); continue; }
    if (rows.some((r) => r.i.amount === null)) { sum.skipped.push({ confirmationCode: code, reason: "Email chưa quy được ra VNĐ" }); continue; }
    const dated = rows.filter((r) => r.i.checkIn && r.i.checkOut);
    if (!dated.length) { sum.skipped.push({ confirmationCode: code, reason: "Email không có ngày ở" }); continue; }
    const amount = rows.reduce((s, r) => s + r.i.amount!, 0);
    if (amount <= 0) continue;
    const checkIn = dated.map((r) => r.i.checkIn!).sort()[0];
    const checkOut = dated.map((r) => r.i.checkOut!).sort().at(-1)!;
    if (checkOut <= checkIn) { sum.skipped.push({ confirmationCode: code, reason: "Ngày ở không hợp lệ" }); continue; }
    wanted.set(code, { code, roomId, propertyId, guestName: rows.find((r) => r.i.guestName)?.i.guestName ?? null, checkIn, checkOut, amount });
  }

  const prevByCode = new Map(existing.map((b) => [b.externalId!, b]));
  for (const w of wanted.values()) {
    const externalId = payoutExternalId(w.code);
    const prev = prevByCode.get(externalId);
    prevByCode.delete(externalId);
    // Phòng đã có đơn khác trùng ngày (thường là đơn Dayladau chưa khớp được mã): không dựng để khỏi tính trùng doanh thu
    const clash = await db
      .select({ id: bookings.id, externalId: bookings.externalId })
      .from(bookings)
      .where(and(eq(bookings.roomId, w.roomId), eq(bookings.status, "CONFIRMED"), lt(bookings.checkIn, w.checkOut), gt(bookings.checkOut, w.checkIn), prev ? ne(bookings.id, prev.id) : undefined))
      .limit(1);
    if (clash.length) {
      sum.skipped.push({ confirmationCode: w.code, reason: clash[0].externalId ? `Phòng đã có đơn ${clash[0].externalId} trùng ngày` : "Phòng đã có đơn tay trùng ngày" });
      if (prev && prev.status === "CONFIRMED") await cancel(db, prev, sum);
      continue;
    }
    const next = {
      source: PAYOUT_SOURCE, externalId, propertyId: w.propertyId, roomId: w.roomId, channel: "Airbnb", guestName: w.guestName, bookedAt: null,
      checkIn: w.checkIn, checkOut: w.checkOut, grossAmount: w.amount, commissionAmount: 0, netAmount: w.amount, status: "CONFIRMED" as const,
      rentalType: null, rawPayload: { airbnbPayout: true, confirmationCode: w.code },
    };
    // Đơn mới rơi vào tháng đã khóa sổ thì không thêm (tháng đã chốt không đổi); đơn đã có thì upsertBooking tự ghi điều chỉnh
    if (!prev && D.splitNights({ id: "new", ...next }).some((n) => lockedMonths.has(D.monthOf(n.nightDate)))) {
      sum.skipped.push({ confirmationCode: w.code, reason: "Có đêm thuộc tháng đã khóa sổ" });
      continue;
    }
    const r = await upsertBooking(db, next, "AIRBNB_PAYOUT", "Dựng từ email payout Airbnb");
    if (r.action === "created") sum.created++;
    else if (r.action === "updated") sum.updated++;
  }

  // Đơn payout không còn cần (đã khớp đơn thật, bỏ gán phòng, xóa email): hủy, giữ lại lịch sử
  for (const b of prevByCode.values()) if (b.status === "CONFIRMED") await cancel(db, b, sum);
}

async function cancel(db: DB, b: typeof bookings.$inferSelect, sum: PayoutBookingSummary) {
  await upsertBooking(db, { ...b, status: "CANCELLED", netAmount: 0, grossAmount: 0 }, "AIRBNB_PAYOUT", "Không còn tính doanh thu từ payout (đã khớp đơn khác, bỏ gán phòng hoặc xóa email)");
  sum.cancelled++;
}

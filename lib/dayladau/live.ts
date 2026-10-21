// Đọc trực tiếp đơn đặt phòng từ API Dayladau (không ghi vào DB), để đối chiếu với đơn đã đồng bộ.
// Admin xem mọi tài khoản Dayladau đang bật; nhà đầu tư chỉ xem các tài khoản Dayladau của mình.
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { bookings, dayladauAccounts, investors, properties, rooms } from "../db/schema";
import type { SessionUser } from "../auth/access";
import * as D from "../domain";
import { decryptSecret } from "../services/settings";
import { httpDayladauClient, type DayladauClient } from "./client";
import { mapDayladauOrder, type MappedBooking } from "./mapping";

export type LiveSyncState = "SYNCED" | "UNMAPPED" | "NOT_SYNCED";

export interface LiveOrder extends MappedBooking {
  investorName: string;
  accountLabel: string;
  roomLabel: string | null; // "Cơ sở · Phòng" nếu listing đã gắn phòng
  sync: LiveSyncState;
}

export interface LiveResult {
  orders: LiveOrder[];
  errors: { investorName: string; accountLabel: string; message: string }[];
  unreadable: number; // đơn đọc lỗi (thiếu id / ngày)
}

export function canViewLiveOrders(user: SessionUser) {
  return user.role === "ADMIN" || user.role === "INVESTOR";
}

/** Đơn có đêm ở trong tháng (giống bookingsForMonth). */
export async function liveOrdersForMonth(db: DB, user: SessionUser, month: string, client: DayladauClient = httpDayladauClient): Promise<LiveResult> {
  const res: LiveResult = { orders: [], errors: [], unreadable: 0 };
  if (!canViewLiveOrders(user)) return res;
  const conds = [eq(dayladauAccounts.active, true)];
  if (user.role === "INVESTOR") conds.push(eq(investors.userId, user.id));
  const accs = await db
    .select({ acc: dayladauAccounts, investorName: investors.name })
    .from(dayladauAccounts)
    .innerJoin(investors, eq(investors.id, dayladauAccounts.investorId))
    .where(and(...conds));
  if (!accs.length) return res;

  const props = await db.select().from(properties).where(inArray(properties.dayladauAccountId, accs.map((a) => a.acc.id)));
  const rs = props.length ? await db.select().from(rooms).where(inArray(rooms.propertyId, props.map((p) => p.id))) : [];
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const from = D.firstDay(month);
  const to = D.lastDay(month);

  const all: { a: (typeof accs)[number]; m: MappedBooking }[] = [];
  // Gọi song song từng tài khoản; một tài khoản lỗi không làm hỏng cả danh sách
  await Promise.all(
    accs.map(async (a) => {
      try {
        const raws = await client.listBookings({ hostId: a.acc.hostId, token: decryptSecret(a.acc.tokenEncrypted) });
        for (const o of raws) {
          try {
            const m = mapDayladauOrder(o);
            if (m.checkIn <= to && m.checkOut > from) all.push({ a, m });
          } catch {
            res.unreadable++;
          }
        }
      } catch (e) {
        res.errors.push({ investorName: a.investorName, accountLabel: a.acc.label, message: (e as Error).message });
      }
    }),
  );

  const ids = all.map((x) => x.m.externalId);
  const synced = new Set(
    ids.length ? (await db.select({ id: bookings.externalId }).from(bookings).where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.externalId, ids)))).map((r) => r.id) : [],
  );
  res.orders = all
    .map(({ a, m }) => {
      const room = rs.find((r) => r.dayladauAccountId === a.acc.id && (r.dayladauRoomId === m.listingKey || r.dayladauRoomId === m.listingName));
      return {
        ...m,
        investorName: a.investorName,
        accountLabel: a.acc.label,
        roomLabel: room ? `${propName[room.propertyId]} · ${room.name}` : null,
        sync: (synced.has(m.externalId) ? "SYNCED" : room ? "NOT_SYNCED" : "UNMAPPED") as LiveSyncState,
      };
    })
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  return res;
}

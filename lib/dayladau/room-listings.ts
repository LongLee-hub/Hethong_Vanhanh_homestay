// Một phòng gắn được nhiều listing Dayladau: listing chính ở rooms.dayladau_room_id, các listing còn lại ở room_listings.
// Mọi chỗ tra "listing này thuộc phòng nào" và mọi chỗ bỏ gắn hàng loạt đi qua đây để hai nơi luôn khớp nhau.
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { roomListings, rooms } from "../db/schema";

type RoomRow = typeof rooms.$inferSelect;
export const listingRef = (accountId: string, listingKey: string) => `${accountId}|${listingKey}`;

/** Phòng theo listing (chính + phụ) của các tài khoản, khóa listingRef(accountId, listingKey). */
export async function roomsByListing(db: DB, accountIds: string[]): Promise<Map<string, RoomRow>> {
  const res = new Map<string, RoomRow>();
  if (!accountIds.length) return res;
  const rs = await db.select().from(rooms).where(inArray(rooms.dayladauAccountId, accountIds));
  const extra = await db
    .select({ room: rooms, accountId: roomListings.dayladauAccountId, listingKey: roomListings.listingKey })
    .from(roomListings)
    .innerJoin(rooms, eq(rooms.id, roomListings.roomId))
    .where(inArray(roomListings.dayladauAccountId, accountIds));
  for (const e of extra) res.set(listingRef(e.accountId, e.listingKey), e.room);
  for (const r of rs) if (r.dayladauRoomId) res.set(listingRef(r.dayladauAccountId!, r.dayladauRoomId), r);
  return res;
}

/** Listing phụ của từng phòng. */
export async function extraListingsOf(db: DB, roomIds: string[]): Promise<Map<string, string[]>> {
  const res = new Map<string, string[]>();
  if (!roomIds.length) return res;
  for (const r of await db.select().from(roomListings).where(inArray(roomListings.roomId, roomIds))) res.set(r.roomId, [...(res.get(r.roomId) ?? []), r.listingKey]);
  return res;
}

/** Bỏ gắn một listing khỏi phòng đang giữ nó. Nếu đó là listing chính, đưa một listing phụ của phòng lên làm chính. */
export async function detachListing(db: DB, accountId: string, listingKey: string) {
  await db.delete(roomListings).where(and(eq(roomListings.dayladauAccountId, accountId), eq(roomListings.listingKey, listingKey)));
  const holders = await db.update(rooms).set({ dayladauAccountId: null, dayladauRoomId: null }).where(and(eq(rooms.dayladauAccountId, accountId), eq(rooms.dayladauRoomId, listingKey))).returning({ id: rooms.id });
  for (const { id } of holders) {
    const [next] = await db.select().from(roomListings).where(and(eq(roomListings.roomId, id), eq(roomListings.dayladauAccountId, accountId))).limit(1);
    if (!next) continue;
    await db.delete(roomListings).where(and(eq(roomListings.dayladauAccountId, accountId), eq(roomListings.listingKey, next.listingKey)));
    await db.update(rooms).set({ dayladauAccountId: accountId, dayladauRoomId: next.listingKey }).where(eq(rooms.id, id));
  }
}

/** Gắn listing vào phòng (phòng phải dùng tài khoản này): phòng chưa có listing thì thành listing chính, đã có thì thêm làm listing phụ. */
export async function attachListing(db: DB, accountId: string, listingKey: string, roomId: string) {
  await detachListing(db, accountId, listingKey);
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (room?.dayladauRoomId && room.dayladauAccountId === accountId) await db.insert(roomListings).values({ roomId, dayladauAccountId: accountId, listingKey });
  else await db.update(rooms).set({ dayladauAccountId: accountId, dayladauRoomId: listingKey }).where(eq(rooms.id, roomId));
}

/** Bỏ mọi listing (chính + phụ) của các phòng, khi listing không còn thuộc tài khoản Dayladau của phòng. */
export async function clearRoomListings(db: DB, where: { roomIds?: string[]; accountId?: string }) {
  if (where.accountId) {
    await db.delete(roomListings).where(eq(roomListings.dayladauAccountId, where.accountId));
    await db.update(rooms).set({ dayladauAccountId: null, dayladauRoomId: null }).where(eq(rooms.dayladauAccountId, where.accountId));
  }
  if (where.roomIds?.length) {
    await db.delete(roomListings).where(inArray(roomListings.roomId, where.roomIds));
    await db.update(rooms).set({ dayladauAccountId: null, dayladauRoomId: null }).where(inArray(rooms.id, where.roomIds));
  }
}

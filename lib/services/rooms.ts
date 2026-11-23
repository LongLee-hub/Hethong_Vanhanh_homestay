// Quản lý phòng: gán phòng vào cơ sở, chuyển phòng, đóng/mở phòng.
import { and, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { DB } from "../db";
import { rowsOf } from "../db/rows";
import { adjustments, bookingNights, bookings, facilityIssues, ignoredListings, properties, reviews, roomListings, rooms, settlements, tasks } from "../db/schema";
import { assertPropertyAccess, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { clearRoomListings, detachListing } from "../dayladau/room-listings";

export type RoomRow = typeof rooms.$inferSelect;

/** Mã listing luôn đi kèm tài khoản Dayladau của cơ sở (mã chỉ duy nhất trong một tài khoản). */
function listingOf(prop: typeof properties.$inferSelect, listingKey: string | null) {
  if (!listingKey) return { dayladauAccountId: null, dayladauRoomId: null };
  if (!prop.dayladauAccountId) throw badRequest("Cơ sở chưa chọn tài khoản Dayladau, chưa gắn được listing");
  return { dayladauAccountId: prop.dayladauAccountId, dayladauRoomId: listingKey };
}

// ---------- Tạo phòng ----------

export interface CreateRoomInput {
  propertyId: string;
  name: string;
  dayladauRoomId?: string | null;
  openedOn: string; // "YYYY-MM-DD"
}

export async function createRoom(db: DB, user: SessionUser, input: CreateRoomInput): Promise<RoomRow> {
  requirePermission(user, "admin");
  if (!input.name?.trim()) throw badRequest("Nhập tên phòng");
  await assertPropertyAccess(db, user, input.propertyId);

  // Kiểm tra cơ sở tồn tại và đang active
  const [prop] = await db.select().from(properties).where(eq(properties.id, input.propertyId)).limit(1);
  if (!prop) throw notFound("Không tìm thấy cơ sở");
  if (!prop.active) throw badRequest("Cơ sở đã ngưng hoạt động");

  const listing = listingOf(prop, input.dayladauRoomId ?? null);
  // Listing đang thuộc phòng khác (chính hoặc phụ) chuyển sang phòng mới
  if (listing.dayladauRoomId) await detachListing(db, listing.dayladauAccountId!, listing.dayladauRoomId);
  const [room] = await db
    .insert(rooms)
    .values({
      propertyId: input.propertyId,
      name: input.name.trim(),
      ...listing,
      openedOn: input.openedOn,
    })
    .returning();
  return room;
}

// ---------- Cập nhật phòng ----------

export interface UpdateRoomInput {
  name?: string;
  /** Listing chính của phòng; listing phụ giữ nguyên. null = bỏ mọi listing của phòng. */
  dayladauRoomId?: string | null;
  revenueKpiMonthly?: number; // VND / tháng
}

export async function updateRoom(db: DB, user: SessionUser, roomId: string, input: UpdateRoomInput): Promise<RoomRow> {
  requirePermission(user, "admin");
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) throw notFound("Không tìm thấy phòng");
  await assertPropertyAccess(db, user, room.propertyId);

  const updates: Partial<typeof rooms.$inferInsert> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw badRequest("Nhập tên phòng");
    updates.name = input.name.trim();
  }
  if (input.dayladauRoomId !== undefined) {
    const [prop] = await db.select().from(properties).where(eq(properties.id, room.propertyId)).limit(1);
    const listing = listingOf(prop!, input.dayladauRoomId);
    if (!listing.dayladauRoomId) await clearRoomListings(db, { roomIds: [roomId] });
    else if (listing.dayladauRoomId !== room.dayladauRoomId) {
      await detachListing(db, listing.dayladauAccountId!, listing.dayladauRoomId);
      Object.assign(updates, listing);
    }
  }
  if (input.revenueKpiMonthly !== undefined) {
    if (!Number.isSafeInteger(input.revenueKpiMonthly) || input.revenueKpiMonthly < 0) throw badRequest("KPI doanh thu phải là số tiền không âm");
    updates.revenueKpiMonthly = input.revenueKpiMonthly;
  }

  if (Object.keys(updates).length === 0) return room;

  const [updated] = await db.update(rooms).set(updates).where(eq(rooms.id, roomId)).returning();
  return updated;
}

// ---------- Chuyển phòng giữa cơ sở ----------

export interface TransferRoomInput {
  roomId: string;
  targetPropertyId: string;
}

/**
 * Chuyển phòng sang cơ sở khác.
 * Kiểm tra: phòng không có booking CONFIRMED đang/sắp diễn ra.
 * Lý do: doanh thu booking gắn với propertyId lúc tạo, chuyển phòng khi có đơn active sẽ gây sai lệch.
 */
export async function transferRoom(db: DB, user: SessionUser, input: TransferRoomInput): Promise<RoomRow> {
  requirePermission(user, "admin");

  const [room] = await db.select().from(rooms).where(eq(rooms.id, input.roomId)).limit(1);
  if (!room) throw notFound("Không tìm thấy phòng");
  if (room.closedOn) throw badRequest("Phòng đã đóng, không thể chuyển");
  await assertPropertyAccess(db, user, room.propertyId);
  await assertPropertyAccess(db, user, input.targetPropertyId);

  if (room.propertyId === input.targetPropertyId) throw badRequest("Phòng đã thuộc cơ sở này");

  // Kiểm tra cơ sở đích tồn tại và active
  const [target] = await db.select().from(properties).where(eq(properties.id, input.targetPropertyId)).limit(1);
  if (!target) throw notFound("Không tìm thấy cơ sở đích");
  if (!target.active) throw badRequest("Cơ sở đích đã ngưng hoạt động");

  // Kiểm tra cùng chủ đầu tư
  const [source] = await db.select().from(properties).where(eq(properties.id, room.propertyId)).limit(1);
  if (source!.investorId !== target.investorId) throw badRequest("Chỉ chuyển phòng giữa các cơ sở cùng chủ đầu tư");

  // Kiểm tra không có booking active (checkOut > today)
  const today = new Date().toISOString().slice(0, 10);
  const activeBookings = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.roomId, input.roomId), eq(bookings.status, "CONFIRMED"), gt(bookings.checkOut, today)))
    .limit(1);
  if (activeBookings.length) throw badRequest("Phòng đang có đơn đặt chưa hoàn thành, không thể chuyển cơ sở");

  // Cơ sở đích dùng tài khoản Dayladau khác: listing đang gắn (chính và phụ) không thuộc tài khoản đó nên bỏ gắn
  if (source!.dayladauAccountId !== target.dayladauAccountId) await clearRoomListings(db, { roomIds: [input.roomId] });
  const [updated] = await db.update(rooms).set({ propertyId: input.targetPropertyId }).where(eq(rooms.id, input.roomId)).returning();
  return updated;
}

// ---------- Đóng / Mở phòng ----------

export async function closeRoom(db: DB, user: SessionUser, roomId: string, closedOn: string): Promise<RoomRow> {
  requirePermission(user, "admin");
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) throw notFound("Không tìm thấy phòng");
  if (room.closedOn) throw badRequest("Phòng đã đóng");
  await assertPropertyAccess(db, user, room.propertyId);

  if (closedOn <= room.openedOn) throw badRequest("Ngày đóng phải sau ngày mở phòng");

  const [updated] = await db.update(rooms).set({ closedOn }).where(eq(rooms.id, roomId)).returning();
  return updated;
}

export async function reopenRoom(db: DB, user: SessionUser, roomId: string): Promise<RoomRow> {
  requirePermission(user, "admin");
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) throw notFound("Không tìm thấy phòng");
  if (!room.closedOn) throw badRequest("Phòng chưa đóng");
  await assertPropertyAccess(db, user, room.propertyId);

  const [updated] = await db.update(rooms).set({ closedOn: null }).where(eq(rooms.id, roomId)).returning();
  return updated;
}

// ---------- Lấy danh sách phòng của 1 cơ sở ----------

export async function roomsOfProperty(db: DB, user: SessionUser, propertyId: string): Promise<RoomRow[]> {
  await assertPropertyAccess(db, user, propertyId);
  return db.select().from(rooms).where(eq(rooms.propertyId, propertyId));
}

// ---------- Xóa phòng ----------

/**
 * Xóa hẳn phòng khỏi hệ thống (không còn trên báo cáo), dùng cho phòng tạo nhầm hoặc listing cũ không dùng nữa.
 * Xóa luôn đơn Dayladau của phòng; listing của phòng được đưa vào danh sách bỏ qua để đồng bộ không nhập lại.
 * Không xóa được khi:
 * - phòng có đơn ngoài OTA nhập tay (có ảnh chuyển khoản) — chuyển hoặc xóa đơn đó trước;
 * - phòng có đơn đã nằm trong tháng khóa sổ lúc khóa (xóa sẽ làm sai quyết toán đã chốt) — dùng Đóng phòng.
 */
export async function deleteRoom(db: DB, user: SessionUser, roomId: string): Promise<{ bookings: number; listings: string[] }> {
  requirePermission(user, "admin");
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room) throw notFound("Không tìm thấy phòng");
  await assertPropertyAccess(db, user, room.propertyId);
  const [prop] = await db.select({ investorId: properties.investorId }).from(properties).where(eq(properties.id, room.propertyId)).limit(1);

  const bs = await db.select({ id: bookings.id, source: bookings.source }).from(bookings).where(eq(bookings.roomId, roomId));
  const manual = bs.filter((b) => b.source === "MANUAL").length;
  if (manual) throw badRequest(`Phòng có ${manual} đơn nhập tay (ngoài OTA). Chuyển hoặc xóa các đơn đó trước khi xóa phòng.`);

  // Đơn đã được tính khi khóa sổ: đơn tạo trước lúc khóa và có đêm trong tháng khóa
  if (bs.length && prop) {
    const locked = await db.execute(sql`
      select distinct to_char(n.night_date, 'YYYY-MM') as month
      from ${bookingNights} n
      join ${settlements} s on s.investor_id = ${prop.investorId} and s.status = 'LOCKED' and s.month = to_char(n.night_date, 'YYYY-MM')
      where n.room_id = ${roomId}
        and (s.locked_at is null or exists (
          select 1 from booking_change_logs l where l.booking_id = n.booking_id and l.changed_at < s.locked_at))
      order by 1`);
    const months = rowsOf<{ month: string }>(locked).map((r) => r.month);
    if (months.length) throw badRequest(`Phòng có đơn đã tính vào tháng đã khóa sổ (${months.join(", ")}). Xóa sẽ làm sai quyết toán; hãy dùng Đóng phòng.`);
  }

  const extra = await db.select({ accountId: roomListings.dayladauAccountId, key: roomListings.listingKey }).from(roomListings).where(eq(roomListings.roomId, roomId));
  const listings = [
    ...(room.dayladauAccountId && room.dayladauRoomId ? [{ accountId: room.dayladauAccountId, key: room.dayladauRoomId }] : []),
    ...extra,
  ];

  await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    const ids = bs.map((b) => b.id);
    if (ids.length) {
      await t.delete(adjustments).where(inArray(adjustments.bookingId, ids));
      await t.delete(bookings).where(inArray(bookings.id, ids)); // đêm và lịch sử đơn xóa theo (cascade)
    }
    await t.update(reviews).set({ roomId: null }).where(eq(reviews.roomId, roomId));
    await t.update(tasks).set({ roomId: null }).where(eq(tasks.roomId, roomId));
    await t.update(facilityIssues).set({ roomId: null }).where(eq(facilityIssues.roomId, roomId));
    for (const l of listings) {
      await t.insert(ignoredListings).values({ dayladauAccountId: l.accountId, listingKey: l.key, reason: `Phòng "${room.name}" đã xóa` }).onConflictDoNothing();
    }
    await t.delete(rooms).where(eq(rooms.id, roomId)); // listing phụ, phòng gán listing Airbnb xóa theo (cascade)
  });
  return { bookings: bs.length, listings: listings.map((l) => l.key) };
}

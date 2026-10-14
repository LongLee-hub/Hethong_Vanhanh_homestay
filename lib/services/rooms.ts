// Quản lý phòng: gán phòng vào cơ sở, chuyển phòng, đóng/mở phòng.
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { DB } from "../db";
import { bookings, properties, rooms } from "../db/schema";
import { assertPropertyAccess, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";

export type RoomRow = typeof rooms.$inferSelect;

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

  const [room] = await db
    .insert(rooms)
    .values({
      propertyId: input.propertyId,
      name: input.name.trim(),
      dayladauRoomId: input.dayladauRoomId ?? null,
      openedOn: input.openedOn,
    })
    .returning();
  return room;
}

// ---------- Cập nhật phòng ----------

export interface UpdateRoomInput {
  name?: string;
  dayladauRoomId?: string | null;
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
  if (input.dayladauRoomId !== undefined) updates.dayladauRoomId = input.dayladauRoomId;

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

  const [updated] = await db
    .update(rooms)
    .set({ propertyId: input.targetPropertyId })
    .where(eq(rooms.id, input.roomId))
    .returning();
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

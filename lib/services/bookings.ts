// Ghi đơn đặt phòng: tạo lại đêm, ghi log, sinh điều chỉnh cho tháng đã khóa (Đặc tả 5.1, 5.6, 6).
import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { adjustments, alerts, bookingChangeLogs, bookingNights, bookings, properties, rooms, settlements } from "../db/schema";
import { assertPropertyAccess, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";

export type BookingRow = typeof bookings.$inferSelect;
export type BookingInput = Omit<typeof bookings.$inferInsert, "id"> & { id?: string };

const TRACKED = ["roomId", "checkIn", "checkOut", "grossAmount", "commissionAmount", "netAmount", "status", "rentalType"] as const;

function snapshot(b: Pick<BookingRow, (typeof TRACKED)[number]>) {
  return Object.fromEntries(TRACKED.map((k) => [k, b[k] ?? null]));
}

function toLite(b: Pick<BookingRow, "id" | "propertyId" | "roomId" | "checkIn" | "checkOut" | "netAmount" | "status" | "rentalType">): D.BookingLite {
  return { id: b.id, propertyId: b.propertyId, roomId: b.roomId, checkIn: b.checkIn, checkOut: b.checkOut, netAmount: b.netAmount, status: b.status, rentalType: b.rentalType };
}

async function investorOf(tx: DB, propertyId: string): Promise<string> {
  const [p] = await tx.select({ investorId: properties.investorId }).from(properties).where(eq(properties.id, propertyId)).limit(1);
  if (!p) throw notFound("Không tìm thấy cơ sở");
  return p.investorId;
}

async function lockedMonthsOf(tx: DB, investorIds: string[]): Promise<Set<string>> {
  if (!investorIds.length) return new Set();
  const rows = await tx
    .select({ month: settlements.month, investorId: settlements.investorId })
    .from(settlements)
    .where(and(inArray(settlements.investorId, investorIds), eq(settlements.status, "LOCKED")));
  return new Set(rows.map((r) => `${r.investorId}|${r.month}`));
}

/** Tháng mở sớm nhất sau `month` của NĐT (nơi ghi khoản điều chỉnh). */
function nextOpenMonth(month: string, investorId: string, locked: Set<string>): string {
  let m = D.nextMonth(month);
  while (locked.has(`${investorId}|${m}`)) m = D.nextMonth(m);
  return m;
}

export interface UpsertResult {
  bookingId: string;
  action: "created" | "updated" | "unchanged";
  adjustments: { propertyId: string; originalMonth: string; appliedMonth: string; amount: number }[];
}

/**
 * Tạo hoặc cập nhật một đơn trong một transaction.
 * Tìm đơn cũ theo id, hoặc theo externalId (đơn Dayladau).
 */
export async function upsertBooking(db: DB, input: BookingInput, changedBy: string, reason?: string): Promise<UpsertResult> {
  if (input.checkOut <= input.checkIn && input.status === "CONFIRMED") throw badRequest("Ngày trả phòng phải sau ngày nhận phòng");
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    let prev: BookingRow | undefined;
    if (input.id) [prev] = await t.select().from(bookings).where(eq(bookings.id, input.id)).limit(1);
    else if (input.externalId) [prev] = await t.select().from(bookings).where(eq(bookings.externalId, input.externalId)).limit(1);

    const id = prev?.id ?? input.id ?? crypto.randomUUID();
    const next = { ...(prev ?? {}), ...input, id } as BookingRow;

    if (prev && JSON.stringify(snapshot(prev)) === JSON.stringify(snapshot(next))) {
      if (input.source === "DAYLADAU") {
        await t.update(bookings).set({ lastSyncedAt: new Date(), rawPayload: input.rawPayload ?? prev.rawPayload, guestName: next.guestName }).where(eq(bookings.id, id));
      }
      return { bookingId: id, action: "unchanged" as const, adjustments: [] };
    }

    if (prev) await t.update(bookings).set({ ...input, id }).where(eq(bookings.id, id));
    else await t.insert(bookings).values({ ...input, id });

    await t.insert(bookingChangeLogs).values({ bookingId: id, changedBy, reason: reason ?? null, before: prev ? snapshot(prev) : null, after: snapshot(next) });

    // 5.1: xóa và tạo lại các đêm
    await t.delete(bookingNights).where(eq(bookingNights.bookingId, id));
    const newNights = D.splitNights(toLite(next));
    if (newNights.length) {
      await t.insert(bookingNights).values(newNights.map((n) => ({ bookingId: id, propertyId: n.propertyId, roomId: n.roomId, nightDate: n.nightDate, netAmount: n.netAmount, kind: n.kind ?? "NIGHT" })));
    }

    // 5.6: điều chỉnh cho tháng đã khóa
    const created: UpsertResult["adjustments"] = [];
    if (prev) {
      const invIds = [...new Set([await investorOf(t, prev.propertyId), await investorOf(t, next.propertyId)])];
      const locked = await lockedMonthsOf(t, invIds);
      const lockedMonths = new Set([...locked].map((k) => k.split("|")[1]));
      const oldNights = D.splitNights(toLite(prev));
      for (const d of D.lockedMonthDeltas(oldNights, newNights, lockedMonths)) {
        const inv = await investorOf(t, d.propertyId);
        if (!locked.has(`${inv}|${d.month}`)) continue;
        const applied = nextOpenMonth(d.month, inv, locked);
        await t.insert(adjustments).values({ propertyId: d.propertyId, appliedMonth: applied, originalMonth: d.month, bookingId: id, amount: d.delta, reason: reason ?? "Đơn thay đổi sau khi tháng đã khóa" });
        await t
          .insert(alerts)
          .values({ type: "LOCKED_MONTH_CHANGED", key: `LOCKED_MONTH_CHANGED:${id}:${d.month}:${Date.now()}`, propertyId: d.propertyId, month: applied, message: `Đơn ${next.externalId ?? id} thay đổi ảnh hưởng tháng đã khóa ${d.month}: ${D.formatVND(d.delta)} ghi vào ${applied}` })
          .onConflictDoNothing();
        created.push({ propertyId: d.propertyId, originalMonth: d.month, appliedMonth: applied, amount: d.delta });
      }
    }
    return { bookingId: id, action: prev ? ("updated" as const) : ("created" as const), adjustments: created };
  });
}

/** Tạo/sửa đơn ngoài OTA từ giao diện. */
export async function saveManualBooking(
  db: DB,
  user: SessionUser,
  input: { id?: string; propertyId: string; roomId: string; guestName: string; bookedAt?: string; checkIn: string; checkOut: string; amount: number; status: "CONFIRMED" | "CANCELLED"; transferProofUrl: string; reason?: string },
) {
  requirePermission(user, "createManualBooking");
  await assertPropertyAccess(db, user, input.propertyId);
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw badRequest("Số tiền không hợp lệ");
  if (!input.transferProofUrl) throw badRequest("Đơn ngoài OTA bắt buộc có ảnh chuyển khoản");
  const [room] = await db.select().from(rooms).where(and(eq(rooms.id, input.roomId), eq(rooms.propertyId, input.propertyId))).limit(1);
  if (!room) throw badRequest("Phòng không thuộc cơ sở này");

  if (input.id) {
    const [prev] = await db.select().from(bookings).where(eq(bookings.id, input.id)).limit(1);
    if (!prev) throw notFound("Không tìm thấy đơn");
    if (prev.source !== "MANUAL") throw badRequest("Đơn Dayladau chỉ đọc; thay đổi đến từ đồng bộ");
    await assertPropertyAccess(db, user, prev.propertyId);
    if (user.role !== "ADMIN" && prev.createdById !== user.id) throw badRequest("Chỉ người tạo đơn hoặc Admin được sửa");
    if (await touchesLockedMonth(db, prev)) throw badRequest("Đơn có đêm thuộc tháng đã khóa sổ");
  }
  const draft = { id: input.id ?? "new", propertyId: input.propertyId, roomId: input.roomId, checkIn: input.checkIn, checkOut: input.checkOut, netAmount: input.amount, status: input.status, rentalType: null };
  if (await touchesLockedMonth(db, draft)) throw badRequest("Đơn có đêm rơi vào tháng đã khóa sổ");

  if (input.status === "CONFIRMED") {
    const clash = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.roomId, input.roomId), eq(bookings.status, "CONFIRMED"), lt(bookings.checkIn, input.checkOut), gt(bookings.checkOut, input.checkIn), input.id ? ne(bookings.id, input.id) : undefined))
      .limit(1);
    if (clash.length) throw badRequest("Phòng đã có khách trong khoảng ngày này");
  }

  return upsertBooking(
    db,
    {
      id: input.id,
      source: "MANUAL",
      externalId: null,
      propertyId: input.propertyId,
      roomId: input.roomId,
      channel: "Direct",
      guestName: input.guestName,
      bookedAt: input.bookedAt ?? null,
      checkIn: input.checkIn,
      checkOut: input.checkOut,
      grossAmount: input.amount,
      commissionAmount: 0,
      netAmount: input.amount,
      status: input.status,
      transferProofUrl: input.transferProofUrl,
      createdById: input.id ? undefined : user.id,
    },
    user.id,
    input.reason,
  );
}

async function touchesLockedMonth(db: DB, b: Parameters<typeof toLite>[0]): Promise<boolean> {
  const inv = await investorOf(db, b.propertyId);
  const locked = await lockedMonthsOf(db, [inv]);
  return D.splitNights(toLite(b)).some((n) => locked.has(`${inv}|${D.monthOf(n.nightDate)}`));
}

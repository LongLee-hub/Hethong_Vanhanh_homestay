import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db";
import { rowsOf } from "../db/rows";
import { bookings, rooms } from "../db/schema";

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

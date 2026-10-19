// Quyền xem ảnh đã lưu (hóa đơn chi phí, ảnh chuyển khoản của đơn ngoài OTA).
// Ảnh nằm trong bucket private; chỉ người xem được bản ghi chứa ảnh mới xem được ảnh.
import { arrayContains, eq } from "drizzle-orm";
import type { DB } from "../db";
import { bookings, expenses } from "../db/schema";
import { allowedPropertyIds, can, type SessionUser } from "../auth/access";

const SAFE_PATH = /^[\w-]+\/[\w./-]+$/;

export async function canViewPhoto(db: DB, user: SessionUser, stored: string): Promise<boolean> {
  if (!SAFE_PATH.test(stored) || stored.includes("..")) return false;
  const [exp] = await db.select({ propertyId: expenses.propertyId }).from(expenses).where(arrayContains(expenses.receiptUrls, [stored])).limit(1);
  if (exp) {
    if (!can(user, "viewFinance")) return false;
    // Chi phí chung: ai xem được tài chính đều thấy danh sách chi phí chung, nên thấy cả hóa đơn
    return exp.propertyId === null || (await allowedPropertyIds(db, user)).includes(exp.propertyId);
  }
  const [bk] = await db.select({ propertyId: bookings.propertyId }).from(bookings).where(eq(bookings.transferProofUrl, stored)).limit(1);
  if (bk) return can(user, "viewBookingAmounts") && (await allowedPropertyIds(db, user)).includes(bk.propertyId);
  return false;
}

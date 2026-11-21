// Quyền xem ảnh đã lưu (hóa đơn chi phí, ảnh chuyển khoản của đơn ngoài OTA).
// Ảnh nằm trong bucket private; chỉ người xem được bản ghi chứa ảnh mới xem được ảnh.
import { arrayContains, eq, or } from "drizzle-orm";
import type { DB } from "../db";
import { attendance, bookings, expenses, facilityIssues, tasks } from "../db/schema";
import { onShiftAt } from "./tasks";
import { SAMPLE_FOLDER } from "./checklists";
import { allowedPropertyIds, can, type SessionUser } from "../auth/access";

const SAFE_PATH = /^[\w-]+\/[\w./-]+$/;

export async function canViewPhoto(db: DB, user: SessionUser, stored: string): Promise<boolean> {
  if (!SAFE_PATH.test(stored) || stored.includes("..")) return false;
  // Ảnh mẫu checklist: ảnh hướng dẫn, không riêng tư, ai làm việc dọn phòng hoặc quản lý đều xem được
  if (stored.split("/")[1] === SAMPLE_FOLDER) return can(user, "workTask") || can(user, "assignTask");
  const [exp] = await db.select({ propertyId: expenses.propertyId }).from(expenses).where(arrayContains(expenses.receiptUrls, [stored])).limit(1);
  if (exp) {
    if (!can(user, "viewFinance")) return false;
    // Chi phí chung: ai xem được tài chính đều thấy danh sách chi phí chung, nên thấy cả hóa đơn
    return exp.propertyId === null || (await allowedPropertyIds(db, user)).includes(exp.propertyId);
  }
  const [bk] = await db.select({ propertyId: bookings.propertyId }).from(bookings).where(eq(bookings.transferProofUrl, stored)).limit(1);
  if (bk) return can(user, "viewBookingAmounts") && (await allowedPropertyIds(db, user)).includes(bk.propertyId);
  // Ảnh chấm công: chính người chấm, hoặc người xem chấm công của cơ sở đó
  const [att] = await db.select({ userId: attendance.userId, propertyId: attendance.propertyId }).from(attendance)
    .where(or(eq(attendance.photoUrl, stored), eq(attendance.checkOutPhotoUrl, stored))).limit(1);
  if (att) return att.userId === user.id || (can(user, "viewAllAttendance") && (await allowedPropertyIds(db, user)).includes(att.propertyId));
  // Ảnh nghiệm thu công việc / checklist dọn phòng: người xem được cơ sở, hoặc người đang có ca ở đó (ca hỗ trợ)
  const [tk] = await db.select({ propertyId: tasks.propertyId }).from(tasks).where(arrayContains(tasks.photoUrls, [stored])).limit(1);
  if (tk) return can(user, "workTask") && ((await allowedPropertyIds(db, user)).includes(tk.propertyId) || (await onShiftAt(db, user.id, tk.propertyId)));
  const [is] = await db.select({ propertyId: facilityIssues.propertyId, by: facilityIssues.reportedById }).from(facilityIssues).where(eq(facilityIssues.photoUrl, stored)).limit(1);
  if (is) return is.by === user.id || (can(user, "workTask") && (await allowedPropertyIds(db, user)).includes(is.propertyId));
  return false;
}

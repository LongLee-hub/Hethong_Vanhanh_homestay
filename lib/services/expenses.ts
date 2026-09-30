// Chi phí và kê khai chi phí chung (Đặc tả 5.3, 7.3).
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { expenseCategories, expenses, monthPeriods } from "../db/schema";
import { allowedPropertyIds, assertPropertyAccess, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { isAnyInvestorLocked, isCommonFinalized, isPropertyMonthLocked } from "./settlement";

export interface ExpenseInput {
  propertyId: string | null;
  categoryId: string;
  month: string;
  incurredOn: string;
  amount: number;
  description: string;
  paymentStatus?: "UNPAID" | "PAID";
  receiptUrls?: string[];
  taskId?: string | null;
}

async function assertMonthOpen(db: DB, propertyId: string | null, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("Tháng hạch toán phải dạng YYYY-MM");
  if (propertyId ? await isPropertyMonthLocked(db, propertyId, month) : await isAnyInvestorLocked(db, month)) {
    throw badRequest(`Tháng ${month} đã khóa sổ, không thêm/sửa/xóa chi phí`);
  }
  if (propertyId === null && (await isCommonFinalized(db, month))) {
    throw badRequest(`Chi phí chung tháng ${month} đã hoàn tất kê khai. Mở lại kê khai trước.`);
  }
}

async function validate(db: DB, i: ExpenseInput) {
  if (!Number.isSafeInteger(i.amount) || i.amount <= 0) throw badRequest("Số tiền phải là số nguyên VND lớn hơn 0");
  if (!i.description?.trim()) throw badRequest("Nhập mô tả khoản chi");
  const [c] = await db.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.id, i.categoryId)).limit(1);
  if (!c) throw badRequest("Loại chi phí không tồn tại");
}

export async function createExpense(db: DB, user: SessionUser, i: ExpenseInput) {
  requirePermission(user, "editExpense");
  await validate(db, i);
  if (i.propertyId) await assertPropertyAccess(db, user, i.propertyId);
  else requirePermission(user, "declareCommon");
  await assertMonthOpen(db, i.propertyId, i.month);
  const [row] = await db
    .insert(expenses)
    .values({ ...i, paymentStatus: i.paymentStatus ?? "UNPAID", paidAt: i.paymentStatus === "PAID" ? new Date() : null, receiptUrls: i.receiptUrls ?? [], createdById: user.id })
    .returning();
  return row;
}

export async function updateExpense(db: DB, user: SessionUser, id: string, patch: Partial<ExpenseInput>) {
  requirePermission(user, "editExpense");
  const [prev] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  if (!prev) throw notFound("Không tìm thấy chi phí");
  if (prev.propertyId) await assertPropertyAccess(db, user, prev.propertyId);
  await assertMonthOpen(db, prev.propertyId, prev.month);
  const next = { ...prev, ...patch };
  await validate(db, next as ExpenseInput);
  if (next.propertyId !== prev.propertyId || next.month !== prev.month) {
    if (next.propertyId) await assertPropertyAccess(db, user, next.propertyId);
    await assertMonthOpen(db, next.propertyId, next.month);
  }
  const [row] = await db.update(expenses).set(patch).where(eq(expenses.id, id)).returning();
  return row;
}

export async function deleteExpense(db: DB, user: SessionUser, id: string) {
  requirePermission(user, "editExpense");
  const [prev] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  if (!prev) throw notFound("Không tìm thấy chi phí");
  if (prev.propertyId) await assertPropertyAccess(db, user, prev.propertyId);
  await assertMonthOpen(db, prev.propertyId, prev.month);
  await db.delete(expenses).where(eq(expenses.id, id));
}

/** Đổi trạng thái hàng loạt. Không ảnh hưởng lãi lỗ nên được phép cả với tháng đã khóa. */
export async function markPaid(db: DB, user: SessionUser, ids: string[]) {
  requirePermission(user, "markPaid");
  if (!ids.length) return 0;
  const allowed = await allowedPropertyIds(db, user);
  const rows = await db.select().from(expenses).where(inArray(expenses.id, ids));
  const ok = rows.filter((e) => e.propertyId === null ? user.role === "ADMIN" || user.role === "ACCOUNTANT" : allowed.includes(e.propertyId));
  if (ok.length !== ids.length) throw notFound("Có khoản chi phí không tồn tại hoặc ngoài phạm vi");
  await db.update(expenses).set({ paymentStatus: "PAID", paidAt: new Date() }).where(inArray(expenses.id, ids));
  return ok.length;
}

export async function setCommonFinalized(db: DB, user: SessionUser, month: string, finalized: boolean) {
  requirePermission(user, "declareCommon");
  if (await isAnyInvestorLocked(db, month)) throw badRequest("Đã có NĐT khóa sổ tháng này");
  await db.insert(monthPeriods).values({ month, commonCostsFinalized: finalized }).onConflictDoUpdate({ target: monthPeriods.month, set: { commonCostsFinalized: finalized } });
}

export async function listExpenses(db: DB, user: SessionUser, month: string) {
  const allowed = await allowedPropertyIds(db, user);
  const direct = allowed.length ? await db.select().from(expenses).where(and(eq(expenses.month, month), inArray(expenses.propertyId, allowed))) : [];
  // Chi phí chung: người xem tài chính đều thấy tổng; chi tiết cho Admin/Kế toán
  return direct;
}

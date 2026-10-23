// Chi phí và kê khai chi phí chung (Đặc tả 5.3, 7.3).
//
// Luồng duyệt chi:
//   Kế toán kê khai → PENDING (chưa tính vào lãi lỗ) → gửi nhóm Lark có chủ nhà kèm link duyệt
//   → Chủ đầu tư "Duyệt & xác nhận đã chi" → APPROVED + PAID → mới ghi nhận vào quyết toán, báo cáo.
//   Chủ đầu tư từ chối → REJECTED (kèm lý do); kế toán sửa lại là gửi duyệt lại (PENDING).
//   Chi phí chung (toàn hệ thống, không thuộc NĐT nào) do Admin duyệt; Admin tự kê khai chi phí chung thì duyệt luôn.
// Sửa / xóa: Admin sửa xóa mọi khoản; Kế toán chỉ sửa xóa khoản chưa duyệt.
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { DB } from "../db";
import { bankTransactions, expenseCategories, expenses, monthPeriods, properties } from "../db/schema";
import {
  allowedPropertyIds, assertPropertyAccess, badRequest, can, forbidden, notFound, requirePermission, type SessionUser,
} from "../auth/access";
import { isAnyInvestorLocked, isCommonFinalized, isPropertyMonthLocked } from "./settlement";

export type ExpenseRow = typeof expenses.$inferSelect;
export type ApprovalStatus = ExpenseRow["approvalStatus"];

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
  bankTransactionId?: string | null;
}

/** Trường được phép sửa. */
export type ExpensePatch = Partial<Pick<ExpenseInput, "propertyId" | "categoryId" | "month" | "incurredOn" | "amount" | "description" | "receiptUrls">>;

async function assertMonthOpen(db: DB, propertyId: string | null, month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("Tháng hạch toán phải dạng YYYY-MM");
  if (propertyId ? await isPropertyMonthLocked(db, propertyId, month) : await isAnyInvestorLocked(db, month)) {
    throw badRequest(`Tháng ${month} đã khóa sổ, không thêm/sửa/xóa/duyệt chi phí. Admin mở khóa sổ trước.`);
  }
  if (propertyId === null && (await isCommonFinalized(db, month))) {
    throw badRequest(`Chi phí chung tháng ${month} đã hoàn tất kê khai. Mở lại kê khai trước.`);
  }
}

async function validate(db: DB, i: Pick<ExpenseInput, "amount" | "description" | "categoryId" | "incurredOn">) {
  if (!Number.isSafeInteger(i.amount) || i.amount <= 0) throw badRequest("Số tiền phải là số nguyên VND lớn hơn 0");
  if (!i.description?.trim()) throw badRequest("Nhập mô tả khoản chi");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.incurredOn)) throw badRequest("Ngày phát sinh không hợp lệ");
  const [c] = await db.select({ id: expenseCategories.id }).from(expenseCategories).where(eq(expenseCategories.id, i.categoryId)).limit(1);
  if (!c) throw badRequest("Loại chi phí không tồn tại");
}

async function getOne(db: DB, id: string) {
  const [row] = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
  if (!row) throw notFound("Không tìm thấy chi phí");
  return row;
}

/** Người dùng có được xem khoản chi này không (chi phí chung: mọi vai trò xem tài chính). */
async function assertCanSee(db: DB, user: SessionUser, e: ExpenseRow) {
  requirePermission(user, "viewFinance");
  if (e.propertyId) await assertPropertyAccess(db, user, e.propertyId);
}

/** Admin sửa xóa mọi khoản; Kế toán chỉ khoản chưa duyệt. */
function assertCanModify(user: SessionUser, e: ExpenseRow) {
  requirePermission(user, "editExpense");
  if (user.role !== "ADMIN" && e.approvalStatus === "APPROVED") {
    throw forbidden("Chi phí đã được chủ đầu tư duyệt, chỉ Admin được sửa hoặc xóa");
  }
}

/** Người duyệt khoản chi: NĐT sở hữu cơ sở (hoặc Admin thay mặt); chi phí chung chỉ Admin. */
async function assertCanApprove(db: DB, user: SessionUser, e: ExpenseRow) {
  requirePermission(user, "approveExpense");
  if (e.propertyId === null) {
    if (user.role !== "ADMIN") throw forbidden("Chi phí chung do Admin duyệt");
    return;
  }
  await assertPropertyAccess(db, user, e.propertyId);
}

/**
 * Thêm loại chi phí mới. Khoản chi thuộc loại này được tính vào quyết toán, báo cáo NĐT như mọi loại khác
 * (báo cáo gom theo tên loại). Trùng tên (không phân biệt hoa thường) thì dùng lại loại cũ, bật lại nếu đã ẩn.
 */
export async function createCategory(db: DB, user: SessionUser, rawName: string) {
  requirePermission(user, "editExpense");
  const name = rawName.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) throw badRequest("Nhập tên loại chi phí");
  if (name.length > 60) throw badRequest("Tên loại tối đa 60 ký tự");
  const all = await db.select().from(expenseCategories);
  const same = all.find((c) => c.name.normalize("NFC").toLowerCase() === name.toLowerCase());
  if (same) {
    if (same.active) throw badRequest(`Loại "${same.name}" đã có`);
    const [row] = await db.update(expenseCategories).set({ active: true }).where(eq(expenseCategories.id, same.id)).returning();
    return row;
  }
  const [row] = await db.insert(expenseCategories).values({ name, scope: "DIRECT" }).returning();
  return row;
}

export async function createExpense(db: DB, user: SessionUser, i: ExpenseInput) {
  requirePermission(user, "editExpense");
  await validate(db, i);
  if (i.propertyId) await assertPropertyAccess(db, user, i.propertyId);
  else requirePermission(user, "declareCommon");
  await assertMonthOpen(db, i.propertyId, i.month);
  // Admin kê khai chi phí chung: Admin cũng là người duyệt nên ghi nhận luôn
  const autoApprove = i.propertyId === null && user.role === "ADMIN";
  const paid = i.paymentStatus === "PAID" || autoApprove;
  const now = new Date();
  const [row] = await db
    .insert(expenses)
    .values({
      propertyId: i.propertyId, categoryId: i.categoryId, month: i.month, incurredOn: i.incurredOn, amount: i.amount,
      description: i.description.trim(), taskId: i.taskId ?? null, bankTransactionId: i.bankTransactionId ?? null,
      paymentStatus: paid ? "PAID" : "UNPAID", paidAt: paid ? now : null, receiptUrls: i.receiptUrls ?? [], createdById: user.id,
      approvalStatus: autoApprove ? "APPROVED" : "PENDING", approvedById: autoApprove ? user.id : null, approvedAt: autoApprove ? now : null,
    })
    .returning();
  return row;
}

/**
 * Sửa chi phí. Trả kèm `resubmitted` = true khi khoản bị từ chối được kế toán sửa lại và chuyển về chờ duyệt
 * (nơi gọi gửi lại tin nhắc duyệt).
 */
export async function updateExpense(db: DB, user: SessionUser, id: string, patch: ExpensePatch): Promise<ExpenseRow & { resubmitted: boolean }> {
  const prev = await getOne(db, id);
  await assertCanSee(db, user, prev);
  assertCanModify(user, prev);
  await assertMonthOpen(db, prev.propertyId, prev.month);
  const clean: ExpensePatch = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (clean.description !== undefined) clean.description = clean.description.trim();
  const next = { ...prev, ...clean };
  await validate(db, next);
  if (next.propertyId !== prev.propertyId || next.month !== prev.month) {
    if (next.propertyId) await assertPropertyAccess(db, user, next.propertyId);
    else requirePermission(user, "declareCommon");
    await assertMonthOpen(db, next.propertyId, next.month);
  }
  // Khoản bị từ chối, sửa lại = gửi duyệt lại. Khoản đã duyệt Admin sửa thì giữ nguyên trạng thái duyệt.
  const resubmitted = prev.approvalStatus === "REJECTED";
  // Đổi cơ sở của khoản đã duyệt sang NĐT khác thì NĐT mới chưa duyệt → chuyển về chờ duyệt
  const ownerChanged = prev.approvalStatus === "APPROVED" && next.propertyId !== prev.propertyId;
  const approval = resubmitted || ownerChanged ? { approvalStatus: "PENDING" as const, rejectReason: null, approvedById: null, approvedAt: null } : {};
  const [row] = await db
    .update(expenses)
    .set({ ...clean, ...approval, updatedById: user.id, updatedAt: new Date() })
    .where(eq(expenses.id, id))
    .returning();
  return { ...row, resubmitted: resubmitted || ownerChanged };
}

export async function deleteExpense(db: DB, user: SessionUser, id: string) {
  const prev = await getOne(db, id);
  await assertCanSee(db, user, prev);
  assertCanModify(user, prev);
  await assertMonthOpen(db, prev.propertyId, prev.month);
  await db.transaction(async (tx) => {
    await tx.delete(expenses).where(eq(expenses.id, id));
    // Ghi nhận từ sao kê: trả dòng sao kê về "chưa phân loại" để ghi nhận lại
    if (prev.bankTransactionId) {
      await tx.update(bankTransactions).set({ status: "NEW", handledById: null, handledAt: null }).where(eq(bankTransactions.id, prev.bankTransactionId));
    }
  });
}

/** Chủ đầu tư duyệt và xác nhận đã chi tiền → ghi nhận chi phí. */
export async function approveExpenses(db: DB, user: SessionUser, ids: string[]) {
  if (!ids.length) throw badRequest("Chọn khoản chi cần duyệt");
  const rows = await db.select().from(expenses).where(inArray(expenses.id, ids));
  if (rows.length !== new Set(ids).size) throw notFound("Không tìm thấy chi phí");
  for (const e of rows) {
    await assertCanApprove(db, user, e);
    if (e.approvalStatus !== "PENDING") throw badRequest(`"${e.description}" ${e.approvalStatus === "APPROVED" ? "đã được duyệt" : "đã bị từ chối, chờ kế toán sửa lại"}`);
    await assertMonthOpen(db, e.propertyId, e.month);
  }
  const now = new Date();
  for (const e of rows) {
    await db
      .update(expenses)
      .set({ approvalStatus: "APPROVED", approvedById: user.id, approvedAt: now, rejectReason: null, paymentStatus: "PAID", paidAt: e.paidAt ?? now })
      .where(and(eq(expenses.id, e.id), eq(expenses.approvalStatus, "PENDING")));
  }
  return rows.length;
}

export async function rejectExpenses(db: DB, user: SessionUser, ids: string[], reason: string) {
  if (!ids.length) throw badRequest("Chọn khoản chi cần từ chối");
  if (!reason?.trim()) throw badRequest("Nhập lý do từ chối để kế toán biết cần sửa gì");
  const rows = await db.select().from(expenses).where(inArray(expenses.id, ids));
  if (rows.length !== new Set(ids).size) throw notFound("Không tìm thấy chi phí");
  for (const e of rows) {
    await assertCanApprove(db, user, e);
    if (e.approvalStatus !== "PENDING") throw badRequest(`"${e.description}" không ở trạng thái chờ duyệt`);
  }
  await db
    .update(expenses)
    .set({ approvalStatus: "REJECTED", rejectReason: reason.trim(), approvedById: user.id, approvedAt: new Date() })
    .where(and(inArray(expenses.id, ids), eq(expenses.approvalStatus, "PENDING")));
  return rows.length;
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
  if (finalized) {
    const [pending] = await db
      .select({ id: expenses.id })
      .from(expenses)
      .where(and(isNull(expenses.propertyId), eq(expenses.month, month), ne(expenses.approvalStatus, "APPROVED")))
      .limit(1);
    if (pending) throw badRequest("Còn chi phí chung chưa được duyệt, duyệt hoặc xóa trước khi hoàn tất kê khai");
  }
  await db.insert(monthPeriods).values({ month, commonCostsFinalized: finalized }).onConflictDoUpdate({ target: monthPeriods.month, set: { commonCostsFinalized: finalized } });
}

export async function listExpenses(db: DB, user: SessionUser, month: string) {
  const allowed = await allowedPropertyIds(db, user);
  const direct = allowed.length ? await db.select().from(expenses).where(and(eq(expenses.month, month), inArray(expenses.propertyId, allowed))) : [];
  // Chi phí chung: người xem tài chính đều thấy tổng; chi tiết cho Admin/Kế toán
  return direct;
}

/** Một khoản chi kèm tên cơ sở, loại, NĐT — cho trang duyệt. */
export async function expenseDetail(db: DB, user: SessionUser, id: string) {
  const e = await getOne(db, id);
  await assertCanSee(db, user, e);
  const [cat] = await db.select({ name: expenseCategories.name }).from(expenseCategories).where(eq(expenseCategories.id, e.categoryId)).limit(1);
  const [prop] = e.propertyId ? await db.select({ name: properties.name, investorId: properties.investorId }).from(properties).where(eq(properties.id, e.propertyId)).limit(1) : [];
  const [txn] = e.bankTransactionId ? await db.select().from(bankTransactions).where(eq(bankTransactions.id, e.bankTransactionId)).limit(1) : [];
  let canApprove = false;
  if (e.approvalStatus === "PENDING" && can(user, "approveExpense")) {
    canApprove = await assertCanApprove(db, user, e).then(() => true, () => false);
  }
  return {
    ...e, categoryName: cat?.name ?? "", propertyName: prop?.name ?? "Chi phí chung", bankTxn: txn ?? null, canApprove,
    canModify: can(user, "editExpense") && (user.role === "ADMIN" || e.approvalStatus !== "APPROVED"),
  };
}

/** Khoản chờ người dùng này duyệt (NĐT: cơ sở của mình; Admin: tất cả). Kế toán: các khoản đang chờ trong phạm vi để theo dõi. */
export async function pendingExpenses(db: DB, user: SessionUser) {
  if (!can(user, "viewFinance")) return [];
  const allowed = await allowedPropertyIds(db, user);
  const where = user.role === "ADMIN" || user.role === "ACCOUNTANT"
    ? and(eq(expenses.approvalStatus, "PENDING"), allowed.length ? undefined : isNull(expenses.propertyId))
    : and(eq(expenses.approvalStatus, "PENDING"), inArray(expenses.propertyId, allowed.length ? allowed : ["-"]));
  const rows = await db.select().from(expenses).where(where).orderBy(asc(expenses.incurredOn), desc(expenses.createdAt));
  // Kế toán chỉ thấy chi phí trực tiếp của cơ sở được giao (và chi phí chung)
  return user.role === "ADMIN" ? rows : rows.filter((e) => e.propertyId === null ? user.role === "ACCOUNTANT" : allowed.includes(e.propertyId));
}

// Sao kê ngân hàng: kế toán tải file lên, phân loại từng khoản tiền ra (cơ sở, loại, tháng) và ghi nhận thành chi phí.
// Chi phí ghi nhận từ sao kê đã chi tiền (PAID) nhưng vẫn đi qua bước chủ đầu tư duyệt như kê khai tay.
// Mỗi dòng sao kê chỉ ghi nhận được một lần (khóa theo số tài khoản + số bút toán); xóa chi phí thì dòng trở lại "chưa phân loại".
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DB } from "../db";
import { bankStatements, bankTransactions, expenseCategories, expenses, properties } from "../db/schema";
import { allowedPropertyIds, badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import type { ParsedStatement } from "../bank/statement-parser";
import { classifyTransaction, type Suggestion } from "../bank/classify";
import { createExpense } from "./expenses";

export type BankTxnRow = typeof bankTransactions.$inferSelect;

export interface ImportResult {
  statementId: string | null; // null = file không có giao dịch mới (đã tải trước đó), không lưu lần tải
  added: number; // dòng mới
  duplicates: number; // đã có từ lần tải trước
  outflows: number; // dòng tiền ra mới cần phân loại
  warnings: string[];
}

export async function importStatement(db: DB, user: SessionUser, fileName: string, p: ParsedStatement): Promise<ImportResult> {
  requirePermission(user, "importStatement");
  if (!p.accountNo) throw badRequest("Không đọc được số tài khoản trên sao kê");
  const [st] = await db
    .insert(bankStatements)
    .values({
      bank: p.bank, accountNo: p.accountNo, accountName: p.accountName, fromDate: p.fromDate, toDate: p.toDate,
      openingBalance: p.openingBalance, closingBalance: p.closingBalance, fileName, uploadedById: user.id,
    })
    .returning();
  const inserted = p.rows.length
    ? await db
        .insert(bankTransactions)
        .values(
          p.rows.map((r) => ({
            statementId: st.id, accountNo: p.accountNo, ref: r.ref, txnAt: r.txnAt, bookedOn: r.bookedOn, debit: r.debit, credit: r.credit,
            balance: r.balance, counterparty: r.counterparty, content: r.content, status: r.debit > 0 ? ("NEW" as const) : ("INCOME" as const),
          })),
        )
        .onConflictDoNothing({ target: [bankTransactions.accountNo, bankTransactions.ref] })
        .returning({ id: bankTransactions.id, debit: bankTransactions.debit })
    : [];
  if (!inserted.length) await db.delete(bankStatements).where(eq(bankStatements.id, st.id));
  return {
    statementId: inserted.length ? st.id : null, added: inserted.length, duplicates: p.rows.length - inserted.length, outflows: inserted.filter((r) => r.debit > 0).length,
    warnings: p.warnings,
  };
}

export async function listStatements(db: DB, user: SessionUser) {
  requirePermission(user, "importStatement");
  const rows = await db.select().from(bankStatements).orderBy(desc(bankStatements.uploadedAt)).limit(30);
  const counts = rows.length
    ? await db
        .select({ statementId: bankTransactions.statementId, status: bankTransactions.status, n: sql<number>`count(*)::int` })
        .from(bankTransactions)
        .where(inArray(bankTransactions.statementId, rows.map((r) => r.id)))
        .groupBy(bankTransactions.statementId, bankTransactions.status)
    : [];
  return rows.map((r) => {
    const c = (s: string) => counts.find((x) => x.statementId === r.id && x.status === s)?.n ?? 0;
    return { ...r, newCount: c("NEW"), recorded: c("RECORDED"), ignored: c("IGNORED"), income: c("INCOME") };
  });
}

export interface TxnView extends BankTxnRow {
  suggestion: Suggestion | null; // chỉ dòng chưa phân loại
  expense: { id: string; propertyId: string | null; categoryId: string; month: string; approvalStatus: string } | null;
}

/**
 * Dòng sao kê để phân loại. statementId: chỉ dòng của lần tải đó (dòng trùng với lần tải trước nằm ở lần trước);
 * không truyền: mọi dòng chưa phân loại.
 */
export async function statementTransactions(db: DB, user: SessionUser, statementId: string | null): Promise<TxnView[]> {
  requirePermission(user, "importStatement");
  const where = statementId ? eq(bankTransactions.statementId, statementId) : eq(bankTransactions.status, "NEW");
  const rows = await db.select().from(bankTransactions).where(where).orderBy(asc(bankTransactions.txnAt));
  if (statementId && !rows.length) {
    const [st] = await db.select({ id: bankStatements.id }).from(bankStatements).where(eq(bankStatements.id, statementId)).limit(1);
    if (!st) throw notFound("Không tìm thấy sao kê");
  }
  const allowed = new Set(await allowedPropertyIds(db, user));
  const [props, cats, history, linked] = await Promise.all([
    db.select({ id: properties.id, codes: properties.bankCodes }).from(properties),
    db.select({ id: expenseCategories.id, name: expenseCategories.name }).from(expenseCategories).where(eq(expenseCategories.active, true)),
    db
      .select({ counterparty: bankTransactions.counterparty, content: bankTransactions.content, categoryId: expenses.categoryId, propertyId: expenses.propertyId })
      .from(expenses)
      .innerJoin(bankTransactions, eq(bankTransactions.id, expenses.bankTransactionId))
      .orderBy(desc(expenses.createdAt))
      .limit(2000),
    rows.length
      ? db
          .select({ id: expenses.id, txnId: expenses.bankTransactionId, propertyId: expenses.propertyId, categoryId: expenses.categoryId, month: expenses.month, approvalStatus: expenses.approvalStatus })
          .from(expenses)
          .where(and(isNotNull(expenses.bankTransactionId), inArray(expenses.bankTransactionId, rows.map((r) => r.id))))
      : [],
  ]);
  // Chỉ gợi ý cơ sở người dùng được phép ghi chi phí
  const ctx = { properties: props.filter((p) => allowed.has(p.id)).map((p) => ({ id: p.id, codes: p.codes })), categories: cats, history };
  return rows.map((r) => {
    const e = linked.find((x) => x.txnId === r.id);
    return {
      ...r,
      suggestion: r.status === "NEW" ? classifyTransaction(r, ctx) : null,
      expense: e ? { id: e.id, propertyId: e.propertyId, categoryId: e.categoryId, month: e.month, approvalStatus: e.approvalStatus } : null,
    };
  });
}

export interface RecordItem {
  txnId: string;
  propertyId: string | null; // null = chi phí chung
  categoryId: string;
  month: string;
  description: string;
}

/** Ghi nhận các dòng tiền ra thành chi phí (chờ chủ đầu tư duyệt). Dòng lỗi giữ nguyên để sửa, dòng khác vẫn ghi. */
export async function recordTransactions(db: DB, user: SessionUser, items: RecordItem[]) {
  requirePermission(user, "importStatement");
  if (!items.length) throw badRequest("Chọn ít nhất một dòng để ghi nhận");
  const txns = await db.select().from(bankTransactions).where(inArray(bankTransactions.id, items.map((i) => i.txnId)));
  const created: string[] = [];
  const errors: { txnId: string; message: string }[] = [];
  for (const it of items) {
    const t = txns.find((x) => x.id === it.txnId);
    try {
      if (!t) throw notFound("Không tìm thấy dòng sao kê");
      if (t.status !== "NEW") throw badRequest("Dòng này đã được xử lý");
      if (t.debit <= 0) throw badRequest("Chỉ ghi nhận được khoản tiền ra");
      if (!it.categoryId) throw badRequest("Chọn loại chi phí");
      if (it.propertyId === undefined) throw badRequest("Chọn cơ sở");
      // Giữ trạng thái NEW → RECORDED nguyên tử: chỉ một người ghi nhận được một dòng
      const [claimed] = await db
        .update(bankTransactions)
        .set({ status: "RECORDED", handledById: user.id, handledAt: new Date() })
        .where(and(eq(bankTransactions.id, t.id), eq(bankTransactions.status, "NEW")))
        .returning({ id: bankTransactions.id });
      if (!claimed) throw badRequest("Dòng này vừa được người khác xử lý");
      try {
        const e = await createExpense(db, user, {
          propertyId: it.propertyId, categoryId: it.categoryId, month: it.month, incurredOn: t.bookedOn, amount: t.debit,
          description: it.description?.trim() || t.content, paymentStatus: "PAID", bankTransactionId: t.id,
        });
        created.push(e.id);
      } catch (err) {
        await db.update(bankTransactions).set({ status: "NEW", handledById: null, handledAt: null }).where(eq(bankTransactions.id, t.id));
        throw err;
      }
    } catch (err) {
      errors.push({ txnId: it.txnId, message: err instanceof Error ? err.message : "Lỗi" });
    }
  }
  return { created, errors };
}

/** Đánh dấu không phải chi phí (vd chuyển nội bộ, hoàn tiền) hoặc trả về chưa phân loại. */
export async function setTransactionsIgnored(db: DB, user: SessionUser, ids: string[], ignored: boolean, note?: string) {
  requirePermission(user, "importStatement");
  if (!ids.length) throw badRequest("Chọn dòng");
  const rows = await db
    .update(bankTransactions)
    .set(ignored ? { status: "IGNORED", note: note?.trim() || null, handledById: user.id, handledAt: new Date() } : { status: "NEW", note: null, handledById: null, handledAt: null })
    .where(and(inArray(bankTransactions.id, ids), eq(bankTransactions.status, ignored ? "NEW" : "IGNORED")))
    .returning({ id: bankTransactions.id });
  return rows.length;
}

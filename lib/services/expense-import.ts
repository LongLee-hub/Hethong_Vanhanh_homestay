// Kê khai chi phí hàng loạt từ file Excel (mẫu bảng tổng hợp chi phí tháng).
//   1. preview: đọc file → khớp Cơ sở, Nhóm chi phí theo tên; tính tháng hạch toán; báo dòng lỗi, tháng đã khóa, khoản có thể trùng.
//   2. commit: tạo loại chi phí mới (nếu có) rồi kê khai từng dòng qua createExpense — cùng luồng duyệt như kê khai tay.
import { and, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { DB } from "../db";
import { expenseCategories, expenses, properties } from "../db/schema";
import { allowedPropertyIds, badRequest, can, requirePermission, type SessionUser } from "../auth/access";
import { buildDescription, isCommonName, nameKey, type SheetRow } from "../expenses/sheet";
import { isAnyInvestorLocked, isCommonFinalized, isPropertyMonthLocked } from "./settlement";
import { createCategory, createSplitExpense } from "./expenses";

export const MAX_IMPORT_ROWS = 500;

/** Tháng hạch toán: "paid" = tháng của Ngày chi (quy tắc mặc định); "file" = theo cột Thuộc tháng (trống thì theo Ngày chi). */
export type MonthMode = "paid" | "file";

export interface PreviewRow {
  line: number;
  incurredOn: string;
  month: string;
  /** null = chi phí chung; undefined = chưa khớp được cơ sở */
  propertyId: string | null | undefined;
  propertyName: string;
  categoryId: string | null;
  categoryName: string;
  /** Loại chưa có trong app — sẽ được tạo khi kê khai */
  newCategory: boolean;
  amount: number;
  item: string;
  recipient: string;
  note: string;
  fileMonth: string | null;
  description: string;
  errors: string[];
  warnings: string[];
  /** Khoản đã có trong app cùng cơ sở, ngày, số tiền */
  duplicateOf: string | null;
}

export interface ImportItem {
  line: number;
  propertyId: string | null;
  categoryId: string | null;
  categoryName: string;
  /** Một hoặc nhiều tháng hạch toán; nhiều tháng thì số tiền chia đều mỗi tháng một khoản. */
  months: string[];
  incurredOn: string;
  amount: number;
  description: string;
}

export async function previewExpenseImport(db: DB, user: SessionUser, rows: SheetRow[], mode: MonthMode): Promise<PreviewRow[]> {
  requirePermission(user, "editExpense");
  if (rows.length > MAX_IMPORT_ROWS) throw badRequest(`File có ${rows.length} dòng, tối đa ${MAX_IMPORT_ROWS} dòng mỗi lần`);
  const allowed = await allowedPropertyIds(db, user);
  const props = allowed.length ? await db.select().from(properties).where(inArray(properties.id, allowed)) : [];
  const cats = await db.select().from(expenseCategories);
  const allowCommon = can(user, "declareCommon");

  const findProperty = (raw: string): { id: string | null; name: string } | string => {
    if (isCommonName(raw)) return allowCommon ? { id: null, name: "Chi phí chung (Unix)" } : "Bạn không kê khai được chi phí chung";
    const k = nameKey(raw);
    const exact = props.filter((p) => nameKey(p.name) === k || p.bankCodes.some((c) => nameKey(c) === k));
    const hits = exact.length ? exact : props.filter((p) => { const n = nameKey(p.name); return n.length > 2 && (k.includes(n) || n.includes(k)); });
    if (hits.length === 1) return { id: hits[0].id, name: hits[0].name };
    if (hits.length > 1) return `Cơ sở "${raw}" khớp nhiều cơ sở: ${hits.map((p) => p.name).join(", ")}`;
    return `Không tìm thấy cơ sở "${raw}" (hoặc bạn không được giao cơ sở này)`;
  };

  // Kiểm tra khóa sổ, mỗi (cơ sở, tháng) hỏi DB một lần
  const lockCache = new Map<string, Promise<string | null>>();
  const lockError = (propertyId: string | null, month: string) => {
    const key = `${propertyId ?? "-"}|${month}`;
    if (!lockCache.has(key)) {
      lockCache.set(key, (async () => {
        if (propertyId ? await isPropertyMonthLocked(db, propertyId, month) : await isAnyInvestorLocked(db, month)) return `Tháng ${month} đã khóa sổ`;
        if (propertyId === null && (await isCommonFinalized(db, month))) return `Chi phí chung tháng ${month} đã hoàn tất kê khai`;
        return null;
      })());
    }
    return lockCache.get(key)!;
  };

  // Khoản đã có trong app trong khoảng ngày của file, để báo trùng khi tải lại cùng file
  const days = rows.map((r) => r.incurredOn).filter((d): d is string => !!d).sort();
  const existing = days.length
    ? await db.select({ id: expenses.id, propertyId: expenses.propertyId, incurredOn: expenses.incurredOn, amount: expenses.amount }).from(expenses).where(and(
      gte(expenses.incurredOn, days[0]), lte(expenses.incurredOn, days[days.length - 1]),
      allowed.length ? or(isNull(expenses.propertyId), inArray(expenses.propertyId, allowed)) : isNull(expenses.propertyId),
    ))
    : [];
  const seenInFile = new Map<string, number>();

  const out: PreviewRow[] = [];
  for (const r of rows) {
    const errors = [...r.errors];
    const warnings: string[] = [];
    let propertyId: string | null | undefined;
    let propertyName = r.property;
    if (r.property) {
      const p = findProperty(r.property);
      if (typeof p === "string") errors.push(p);
      else ({ id: propertyId, name: propertyName } = p);
    }
    const cat = r.category ? cats.find((c) => nameKey(c.name) === nameKey(r.category)) : undefined;
    const incurredOn = r.incurredOn ?? "";
    const paidMonth = incurredOn.slice(0, 7);
    const month = mode === "file" ? r.fileMonth ?? paidMonth : paidMonth;
    if (r.fileMonth && paidMonth && r.fileMonth !== paidMonth) {
      warnings.push(mode === "file" ? `Chi ngày ${incurredOn.split("-").reverse().join("/")} nhưng hạch toán ${r.fileMonth} theo cột Thuộc tháng` : `File ghi thuộc ${r.monthText}, hạch toán tháng chi ${paidMonth}`);
    }
    if (propertyId !== undefined && month) {
      const locked = await lockError(propertyId, month);
      if (locked) errors.push(locked);
    }
    let duplicateOf: string | null = null;
    if (propertyId !== undefined && incurredOn) {
      duplicateOf = existing.find((e) => e.propertyId === propertyId && e.incurredOn === incurredOn && e.amount === r.amount)?.id ?? null;
      if (duplicateOf) warnings.push("Đã có khoản cùng cơ sở, ngày, số tiền trong app — có thể đã kê khai");
      const key = `${propertyId}|${incurredOn}|${r.amount}|${nameKey(r.item)}`;
      if (seenInFile.has(key)) warnings.push(`Giống hệt dòng ${seenInFile.get(key)} trong file`);
      else seenInFile.set(key, r.line);
    }
    out.push({
      line: r.line, incurredOn, month, propertyId, propertyName, categoryId: cat?.id ?? null, categoryName: cat?.name ?? r.category,
      newCategory: !!r.category && (!cat || !cat.active), amount: r.amount, item: r.item, recipient: r.recipient, note: r.note,
      fileMonth: r.fileMonth, description: buildDescription(r), errors, warnings, duplicateOf,
    });
  }
  return out;
}

/** Kê khai các dòng đã chọn. Dòng lỗi không làm hỏng dòng khác; trả id khoản đã tạo và lỗi theo số dòng. */
export async function commitExpenseImport(db: DB, user: SessionUser, items: ImportItem[]) {
  requirePermission(user, "editExpense");
  if (!items.length) throw badRequest("Chọn ít nhất một dòng");
  if (items.length > MAX_IMPORT_ROWS) throw badRequest(`Tối đa ${MAX_IMPORT_ROWS} dòng mỗi lần`);
  const errors: { line: number; message: string }[] = [];
  const created: string[] = [];

  // Loại chi phí mới: tạo một lần cho mỗi tên (hoặc bật lại loại đã ẩn)
  const catIds = new Map<string, string>();
  const all = await db.select().from(expenseCategories);
  for (const name of new Set(items.filter((i) => !i.categoryId || !all.some((c) => c.id === i.categoryId && c.active)).map((i) => i.categoryName.trim()).filter(Boolean))) {
    const have = all.find((c) => c.active && nameKey(c.name) === nameKey(name));
    if (have) { catIds.set(nameKey(name), have.id); continue; }
    try {
      catIds.set(nameKey(name), (await createCategory(db, user, name)).id);
    } catch (e) {
      for (const i of items.filter((x) => nameKey(x.categoryName) === nameKey(name))) errors.push({ line: i.line, message: e instanceof Error ? e.message : "Không tạo được loại chi phí" });
    }
  }

  for (const i of items) {
    if (errors.some((e) => e.line === i.line)) continue;
    const categoryId = (i.categoryId && all.some((c) => c.id === i.categoryId && c.active) ? i.categoryId : catIds.get(nameKey(i.categoryName))) ?? "";
    try {
      const rows = await createSplitExpense(db, user, {
        propertyId: i.propertyId, categoryId, incurredOn: i.incurredOn, amount: i.amount, description: i.description,
      }, i.months ?? []);
      created.push(...rows.map((e) => e.id));
    } catch (e) {
      errors.push({ line: i.line, message: e instanceof Error ? e.message : "Lỗi không rõ" });
    }
  }
  return { created, errors };
}

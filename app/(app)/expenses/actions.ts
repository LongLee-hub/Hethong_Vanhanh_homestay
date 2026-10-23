"use server";
// Server action cho chi phí: kê khai, duyệt, sửa/xóa, sao kê. Kiểm tra quyền nằm trong lib/services.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { badRequest } from "@/lib/auth/access";
import { action, appBaseUrl, requireUser } from "@/lib/server";
import { uploadPhoto } from "@/lib/storage";
import { approveExpenses, createCategory, createExpense, deleteExpense, expenseDetail, rejectExpenses, updateExpense } from "@/lib/services/expenses";
import { notifyPendingExpenses } from "@/lib/services/expense-notify";
import { importStatement, recordTransactions, setTransactionsIgnored, type RecordItem } from "@/lib/services/bank-statements";
import { readStatementFile } from "@/lib/bank/statement-parser";

type State = { ok: boolean; error?: string; info?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const money = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/[^\d]/g, ""));
const photo = (f: FormData, name: string) => {
  const v = f.get(name);
  return v instanceof File && v.size > 0 ? v : null;
};

function refresh(id?: string) {
  revalidatePath("/expenses");
  revalidatePath("/expenses/pending");
  revalidatePath("/expenses/bank");
  if (id) revalidatePath(`/expenses/${id}`);
}

/** Gửi nhắc duyệt; lỗi gửi không làm hỏng thao tác chính. */
async function notify(ids: string[], resubmit = false) {
  try {
    return await notifyPendingExpenses(getDb(), ids, await appBaseUrl(), { resubmit });
  } catch (e) {
    console.error("Nhắc duyệt chi phí lỗi", e);
    return { sent: 0, skipped: ids.length };
  }
}

const notifyText = (r: { sent: number; skipped: number; failed?: number }) =>
  r.failed
    ? `gửi Lark lỗi ${r.failed} nhóm (kiểm tra webhook)${r.sent ? `, đã nhắn ${r.sent} nhóm` : ""}`
    : r.sent ? `đã nhắn ${r.sent} nhóm Lark để chủ nhà duyệt` : "chưa cài nhóm Lark nên chưa gửi nhắc duyệt";

export async function declareExpenseAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  let info = "";
  const r = await action(async () => {
    const file = photo(f, "receipt");
    const prop = s(f, "propertyId");
    const e = await createExpense(getDb(), user, {
      propertyId: prop === "__common" ? null : prop, categoryId: s(f, "categoryId"), month: s(f, "month"),
      incurredOn: s(f, "incurredOn"), amount: money(f.get("amount")), description: s(f, "description"),
      receiptUrls: file ? [await uploadPhoto(file, "receipts")] : [], taskId: s(f, "taskId") || null,
    });
    info = e.approvalStatus === "APPROVED" ? "Đã ghi nhận" : `Đã kê khai, ${notifyText(await notify([e.id]))}`;
  });
  refresh();
  return r.ok ? { ...r, info } : r;
}

export async function addCategoryAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  let info = "";
  const r = await action(async () => {
    const c = await createCategory(getDb(), user, s(f, "name"));
    info = `Đã thêm loại "${c.name}"`;
  });
  refresh();
  return r.ok ? { ...r, info } : r;
}

export async function approveAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const ids = f.getAll("ids").map(String);
  const r = await action(() => approveExpenses(getDb(), user, ids));
  refresh(ids.length === 1 ? ids[0] : undefined);
  return r.ok ? { ...r, info: `Đã duyệt ${ids.length} khoản` } : r;
}

export async function rejectAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const ids = f.getAll("ids").map(String);
  const r = await action(() => rejectExpenses(getDb(), user, ids, s(f, "reason")));
  refresh(ids.length === 1 ? ids[0] : undefined);
  return r.ok ? { ...r, info: `Đã từ chối ${ids.length} khoản` } : r;
}

export async function updateExpenseAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const id = s(f, "id");
  let info = "Đã lưu";
  const r = await action(async () => {
    const file = photo(f, "receipt");
    const prev = await expenseDetail(getDb(), user, id);
    const prop = s(f, "propertyId");
    const u = await updateExpense(getDb(), user, id, {
      propertyId: prop === "__common" ? null : prop, categoryId: s(f, "categoryId"), month: s(f, "month"), incurredOn: s(f, "incurredOn"),
      amount: money(f.get("amount")), description: s(f, "description"),
      receiptUrls: file ? [...prev.receiptUrls, await uploadPhoto(file, "receipts")] : undefined,
    });
    if (u.resubmitted) info = `Đã lưu và gửi duyệt lại, ${notifyText(await notify([id], true))}`;
  });
  refresh(id);
  return r.ok ? { ...r, info } : r;
}

export async function deleteExpenseAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const id = s(f, "id");
  const r = await action(() => deleteExpense(getDb(), user, id));
  refresh();
  if (r.ok) redirect(s(f, "back") || "/expenses");
  return r;
}

export async function remindAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const ids = f.getAll("ids").map(String);
  const r = await action(async () => {
    if (!ids.length) throw badRequest("Chọn khoản cần nhắc");
    // Kiểm tra quyền xem từng khoản trước khi gửi ra ngoài
    for (const id of ids) {
      const e = await expenseDetail(getDb(), user, id);
      if (!e.canModify) throw badRequest("Bạn không gửi nhắc được khoản này");
    }
  });
  if (!r.ok) return r;
  return { ok: true, info: notifyText(await notify(ids)).replace(/^./, (c) => c.toUpperCase()) };
}

// ---------- Sao kê ----------

export async function uploadStatementAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const file = f.get("file");
  let to = "";
  const r = await action(async () => {
    if (!(file instanceof File) || !file.size) throw badRequest("Chọn file sao kê (.xlsx)");
    if (file.size > 10 * 1024 * 1024) throw badRequest("File quá lớn (tối đa 10 MB)");
    let parsed;
    try {
      parsed = await readStatementFile(await file.arrayBuffer());
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "Không đọc được file");
    }
    const res = await importStatement(getDb(), user, file.name, parsed);
    to = `/expenses/bank?${res.statementId ? `st=${res.statementId}&` : ""}added=${res.added}&dup=${res.duplicates}${res.warnings.length ? `&warn=${encodeURIComponent(res.warnings.join(" · "))}` : ""}`;
  });
  revalidatePath("/expenses/bank");
  if (r.ok) redirect(to);
  return r;
}

export async function recordTxnsAction(items: RecordItem[]): Promise<{ ok: boolean; error?: string; info?: string; errors?: { txnId: string; message: string }[] }> {
  const user = await requireUser();
  let out: Awaited<ReturnType<typeof recordTransactions>> = { created: [], errors: [] };
  const r = await action(async () => {
    out = await recordTransactions(getDb(), user, items);
  });
  if (!r.ok) return r;
  let info = `Đã ghi nhận ${out.created.length} khoản`;
  if (out.created.length) info += `, ${notifyText(await notify(out.created))}`;
  refresh();
  return { ok: true, info, errors: out.errors };
}

export async function ignoreTxnsAction(ids: string[], ignored: boolean, note?: string) {
  const user = await requireUser();
  const r = await action(() => setTransactionsIgnored(getDb(), user, ids, ignored, note));
  revalidatePath("/expenses/bank");
  return r;
}

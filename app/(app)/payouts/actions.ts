"use server";
// Server action cho trang Payout Airbnb. Quyền kiểm tra trong lib/airbnb/payouts.ts.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { gmailAccounts } from "@/lib/db/schema";
import { badRequest, notFound } from "@/lib/auth/access";
import { action, requireUser } from "@/lib/server";
import { canManageGmail, disconnectGmail, reparsePayout, syncPayouts } from "@/lib/airbnb/payouts";

type State = { ok: boolean; error?: string; message?: string } | null;

export async function syncGmailAction(accountId: string): Promise<State> {
  const user = await requireUser();
  let message = "";
  const r = await action(async () => {
    const db = getDb();
    const [a] = await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, accountId)).limit(1);
    if (!a || !(await canManageGmail(db, user, a.investorId))) throw notFound("Không tìm thấy Gmail");
    const sum = await syncPayouts(db, { accountIds: [accountId] });
    if (sum.errors.length) throw badRequest(`Đọc Gmail lỗi: ${sum.errors[0].message}`);
    message = sum.created ? `Thêm ${sum.created} email payout` : "Không có email payout mới";
  });
  revalidatePath("/payouts");
  return r.ok ? { ok: true, message } : r;
}

export async function disconnectGmailAction(accountId: string): Promise<State> {
  const user = await requireUser();
  const r = await action(() => disconnectGmail(getDb(), user, accountId));
  revalidatePath("/payouts");
  return r;
}

export async function reparsePayoutAction(payoutId: string): Promise<State> {
  const user = await requireUser();
  const r = await action(() => reparsePayout(getDb(), user, payoutId));
  revalidatePath("/payouts");
  return r.ok ? { ok: true, message: "Đã tách lại" } : r;
}

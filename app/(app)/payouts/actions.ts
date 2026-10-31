"use server";
// Server action cho trang Payout Airbnb. Quyền kiểm tra trong lib/airbnb/payouts.ts.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { gmailAccounts } from "@/lib/db/schema";
import { badRequest, can, notFound } from "@/lib/auth/access";
import { action, requireUser } from "@/lib/server";
import * as D from "@/lib/domain";
import { assignListingRoom, canManageGmail, deletePastedPayout, disconnectGmail, importPastedPayout, previewPastedPayout, reparsePayout, syncPayouts, validateBackfill, type BackfillOptions } from "@/lib/airbnb/payouts";
import type { ParsedPayout } from "@/lib/airbnb/payout-parser";
import { saveGoogleSetup } from "@/lib/gmail/config";
import { syncableAccountIds, syncDayladauPayouts } from "@/lib/dayladau/payouts";

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

export async function backfillGmailAction(accountId: string, input: BackfillOptions): Promise<State> {
  const user = await requireUser();
  let message = "";
  const r = await action(async () => {
    const db = getDb();
    const [a] = await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, accountId)).limit(1);
    if (!a || !(await canManageGmail(db, user, a.investorId))) throw notFound("Không tìm thấy Gmail");
    const backfill = validateBackfill(input, D.todayVN());
    const sum = await syncPayouts(db, { accountIds: [accountId], backfill });
    if (sum.errors.length) throw badRequest(`Đọc Gmail lỗi: ${sum.errors[0].message}`);
    const fmt = (d: string) => D.formatDateVN(d);
    if (!sum.messages) message = "Không tìm thấy email payout nào trong khoảng này";
    else if (!sum.created) message = `Đã xem ${sum.messages} email, tất cả đã có trong hệ thống`;
    else {
      message = `Thêm ${sum.created} email payout (${sum.bookings} đơn, ${sum.oldest === sum.newest ? fmt(sum.oldest!) : `${fmt(sum.oldest!)} – ${fmt(sum.newest!)}`}), khớp ${sum.matched} đơn trong hệ thống`;
      if (sum.messages - sum.created > 0) message += `. Bỏ qua ${sum.messages - sum.created} email đã có hoặc gửi lặp`;
    }
    if (backfill.count && sum.messages >= backfill.count) message += ". Muốn đọc xa hơn: chọn Theo khoảng ngày, đặt Đến ngày trước ngày cũ nhất vừa đọc";
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

export async function saveGoogleSetupAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() =>
    saveGoogleSetup(getDb(), user, { clientId: String(f.get("clientId") ?? ""), clientSecret: String(f.get("clientSecret") ?? ""), appUrl: String(f.get("appUrl") ?? "") }),
  );
  revalidatePath("/payouts");
  return r;
}

export type PreviewResult = { ok: true; parsed: ParsedPayout } | { ok: false; error: string };

export async function previewPasteAction(input: { text: string; receivedOn: string }): Promise<PreviewResult> {
  const user = await requireUser();
  if (!can(user, "viewFee")) return { ok: false, error: "Bạn không có quyền thực hiện thao tác này" };
  if (input.text.trim().length < 20) return { ok: false, error: "Dán toàn bộ nội dung email payout" };
  return { ok: true, parsed: previewPastedPayout(input) };
}

export async function importPasteAction(input: { investorId: string; text: string; receivedOn: string }): Promise<State> {
  const user = await requireUser();
  const r = await action(() => importPastedPayout(getDb(), user, input));
  revalidatePath("/payouts");
  return r.ok ? { ok: true, message: "Đã lưu payout" } : r;
}

export async function assignListingRoomAction(input: { investorId: string; listingKey: string; roomId: string | null }): Promise<State> {
  const user = await requireUser();
  let message = input.roomId ? "Đã gán" : "Đã bỏ gán";
  const r = await action(async () => {
    const s = await assignListingRoom(getDb(), user, input);
    const n = s.created + s.updated;
    if (n) message += `, tính ${n} đơn vào doanh thu phòng`;
    if (s.cancelled) message += `, bỏ ${s.cancelled} đơn khỏi doanh thu`;
    if (s.skipped.length) message += `. Chưa tính ${s.skipped.length} đơn: ${s.skipped[0].reason}`;
  });
  revalidatePath("/payouts");
  revalidatePath("/settlements");
  revalidatePath("/bookings");
  return r.ok ? { ok: true, message } : r;
}

export async function deletePastedAction(payoutId: string): Promise<State> {
  const user = await requireUser();
  const r = await action(() => deletePastedPayout(getDb(), user, payoutId));
  revalidatePath("/payouts");
  return r;
}

/** Đồng bộ phiếu thanh toán Dayladau của tháng (một tài khoản, hoặc mọi tài khoản người dùng được xem). */
export async function syncDayladauPayoutsAction(input: { month: string; accountId?: string }): Promise<State> {
  const user = await requireUser();
  let message = "";
  const r = await action(async () => {
    if (!can(user, "viewFee")) throw badRequest("Bạn không có quyền thực hiện thao tác này");
    if (!/^\d{4}-\d{2}$/.test(input.month)) throw badRequest("Tháng không hợp lệ");
    const db = getDb();
    const accountIds = await syncableAccountIds(db, user, input.accountId);
    if (!accountIds.length) throw badRequest("Chưa có tài khoản Dayladau nào đang bật");
    const today = D.todayVN();
    const last = D.lastDay(input.month);
    const sum = await syncDayladauPayouts(db, { accountIds, from: D.firstDay(input.month), to: last < today ? last : today });
    if (sum.errors.length && !sum.payouts) throw badRequest(`Lấy phiếu Dayladau lỗi: ${sum.errors[0].message}`);
    message = sum.payouts
      ? `Lấy ${sum.payouts} phiếu, ${sum.orders} đơn: ${sum.matched} khớp, ${sum.amountDiff} lệch tiền, ${sum.notFound} chưa có trong hệ thống. ${sum.pending} đơn đang chờ trả`
      : `Không có phiếu nào trong ${D.formatMonthVN(input.month).toLowerCase()}. ${sum.pending} đơn đang chờ trả`;
    if (sum.errors.length) message += `. Lỗi ${sum.errors.length} tài khoản: ${sum.errors[0].message}`;
  });
  revalidatePath("/payouts/dayladau");
  return r.ok ? { ok: true, message } : r;
}

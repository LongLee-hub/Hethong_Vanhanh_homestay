"use server";
// Server action cho màn hình kết nối Dayladau. Quyền Admin kiểm tra trong lib/dayladau/admin.ts.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { HttpError, requirePermission } from "@/lib/auth/access";
import { action, requireUser } from "@/lib/server";
import {
  createProperty, createRoom, dismissSyncAlert, mapListingToRoom, saveDayladauAccount, saveInvestor, testConnection, type ConnectionTest,
} from "@/lib/dayladau/admin";
import { syncBookings, type SyncSummary } from "@/lib/dayladau/sync";
import { computeAlerts } from "@/lib/services/alerts";
import { reconcilePayoutRevenue } from "@/lib/airbnb/payouts";

/** Đơn Dayladau mới có thể trùng đơn đã dựng từ payout Airbnb: đối soát lại để hủy đơn payout, không tính doanh thu hai lần. */
const reconcilePayouts = (db: ReturnType<typeof getDb>) => reconcilePayoutRevenue(db).catch((e) => console.error("[payout-revenue]", e));
import * as D from "@/lib/domain";

type State = { ok: boolean; error?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const numOrNull = (f: FormData, k: string) => (s(f, k) ? Number(s(f, k).replace(",", ".")) : null);

/** "Không trả VAT" → null; "Có trả VAT" → mức đã nhập (mặc định 8%). Form cũ không có vatMode thì đọc thẳng vatPct. */
const vatPctOf = (f: FormData) => {
  const mode = s(f, "vatMode");
  if (mode === "0") return null;
  if (mode === "1") return numOrNull(f, "vatPct") ?? 8;
  return numOrNull(f, "vatPct");
};

export async function saveInvestorAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() =>
    saveInvestor(getDb(), user, {
      id: s(f, "id") || undefined, name: s(f, "name"), phone: s(f, "phone"), email: s(f, "email"), taxCode: s(f, "taxCode"), address: s(f, "address"),
      bankName: s(f, "bankName"), bankAccountNo: s(f, "bankAccountNo"), bankAccountName: s(f, "bankAccountName"),
      managementFeePct: numOrNull(f, "managementFeePct"), vatPct: vatPctOf(f), pitPct: numOrNull(f, "pitPct"), sharesCommonCost: s(f, "sharesCommonCost") === "1", contractStartOn: s(f, "contractStartOn") || null, contractEndOn: s(f, "contractEndOn") || null,
      contractUrl: s(f, "contractUrl"), payoutDay: numOrNull(f, "payoutDay"), active: s(f, "active") !== "0", note: s(f, "note"),
      larkWebhookUrl: s(f, "larkWebhookUrl"),
    }),
  );
  revalidatePath("/dayladau");
  return r;
}

export async function saveAccountAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() =>
    saveDayladauAccount(getDb(), user, {
      id: s(f, "id") || undefined, investorId: s(f, "investorId"), label: s(f, "label"), hostId: s(f, "hostId"), token: s(f, "token") || undefined,
      active: f.get("active") === "1", propertyIds: f.getAll("propertyIds").map(String),
    }),
  );
  revalidatePath("/dayladau");
  revalidatePath("/properties");
  return r;
}

export async function testConnectionAction(accountId: string): Promise<ConnectionTest> {
  const user = await requireUser();
  try {
    return await testConnection(getDb(), user, accountId);
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Lỗi máy chủ", ordersOnFirstPage: 0, listings: [], statuses: [], samples: [] };
  }
}

export async function mapListingAction(accountId: string, listingKey: string, roomId: string | null): Promise<State> {
  const user = await requireUser();
  const r = await action(() => mapListingToRoom(getDb(), user, accountId, listingKey, roomId));
  revalidatePath("/dayladau");
  return r;
}

export async function createRoomForListingAction(input: { propertyId: string; name: string; listingKey: string }): Promise<{ ok: boolean; error?: string; roomId?: string }> {
  const user = await requireUser();
  let roomId: string | undefined;
  const r = await action(async () => { roomId = (await createRoom(getDb(), user, { ...input, openedOn: D.todayVN() })).id; });
  revalidatePath("/dayladau");
  return { ...r, roomId };
}

export async function createPropertyAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() =>
    createProperty(getDb(), user, {
      investorId: s(f, "investorId"), name: s(f, "name"), dayladauAccountId: s(f, "dayladauAccountId") || null,
      investmentAmount: Number(s(f, "investmentAmount").replace(/[^\d]/g, "")) || 0, investmentStartMonth: s(f, "investmentStartMonth"),
    }),
  );
  revalidatePath("/dayladau");
  return r;
}

/** full = lấy toàn bộ đơn cũ trên Dayladau (dùng sau khi gắn thêm listing), mặc định chỉ lấy đơn mới nhất. */
export async function syncNowAction(accountId: string, full = false): Promise<{ ok: boolean; error?: string; summary?: SyncSummary }> {
  const user = await requireUser();
  try {
    requirePermission(user, "admin");
    const db = getDb();
    const summary = await syncBookings(db, { accountIds: [accountId], full });
    await reconcilePayouts(db);
    await computeAlerts(db);
    revalidatePath("/dayladau");
    return { ok: summary.errors.length === 0, summary, error: summary.errors[0]?.message };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Lỗi máy chủ" };
  }
}

/** Lấy tất cả đơn Dayladau có đêm trong tháng `month` (YYYY-MM), của một tài khoản (host ID) hoặc mọi tài khoản đang bật. */
export async function syncMonthAction(month: string, accountId?: string): Promise<{ ok: boolean; error?: string; summary?: SyncSummary }> {
  const user = await requireUser();
  try {
    requirePermission(user, "admin");
    if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: "Tháng không hợp lệ" };
    const db = getDb();
    const summary = await syncBookings(db, { month, accountIds: accountId ? [accountId] : undefined });
    await reconcilePayouts(db);
    await computeAlerts(db);
    revalidatePath("/bookings");
    revalidatePath("/dayladau");
    return { ok: summary.errors.length === 0, summary, error: summary.errors[0]?.message };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Lỗi máy chủ" };
  }
}

export async function dismissAlertAction(alertId: string): Promise<State> {
  const user = await requireUser();
  const r = await action(() => dismissSyncAlert(getDb(), user, alertId));
  revalidatePath("/dayladau");
  revalidatePath("/");
  return r;
}

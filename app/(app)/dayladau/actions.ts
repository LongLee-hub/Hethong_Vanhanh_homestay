"use server";
// Server action cho màn hình kết nối Dayladau. Quyền Admin kiểm tra trong lib/dayladau/admin.ts.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { HttpError, requirePermission } from "@/lib/auth/access";
import { action, requireUser } from "@/lib/server";
import { createProperty, createRoom, mapListingToRoom, saveInvestorConnection, testConnection, type ConnectionTest } from "@/lib/dayladau/admin";
import { syncBookings, type SyncSummary } from "@/lib/dayladau/sync";
import { computeAlerts } from "@/lib/services/alerts";
import * as D from "@/lib/domain";

type State = { ok: boolean; error?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export async function saveConnectionAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => saveInvestorConnection(getDb(), user, { id: s(f, "id") || undefined, name: s(f, "name"), hostId: s(f, "hostId"), token: s(f, "token") || undefined }));
  revalidatePath("/dayladau");
  return r;
}

export async function testConnectionAction(investorId: string): Promise<ConnectionTest> {
  const user = await requireUser();
  try {
    return await testConnection(getDb(), user, investorId);
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Lỗi máy chủ", ordersOnFirstPage: 0, listings: [], statuses: [], samples: [] };
  }
}

export async function mapListingAction(investorId: string, listingKey: string, roomId: string | null): Promise<State> {
  const user = await requireUser();
  const r = await action(() => mapListingToRoom(getDb(), user, investorId, listingKey, roomId));
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
      investorId: s(f, "investorId"), name: s(f, "name"),
      investmentAmount: Number(s(f, "investmentAmount").replace(/[^\d]/g, "")) || 0, investmentStartMonth: s(f, "investmentStartMonth"),
    }),
  );
  revalidatePath("/dayladau");
  return r;
}

export async function syncNowAction(investorId: string): Promise<{ ok: boolean; error?: string; summary?: SyncSummary }> {
  const user = await requireUser();
  try {
    requirePermission(user, "admin");
    const db = getDb();
    const summary = await syncBookings(db, { investorIds: [investorId] });
    await computeAlerts(db);
    revalidatePath("/dayladau");
    return { ok: summary.errors.length === 0, summary, error: summary.errors[0]?.message };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Lỗi máy chủ" };
  }
}

"use server";
// Server action cho màn hình Cơ sở & phòng. Quyền Admin kiểm tra trong service.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { action, requireUser } from "@/lib/server";
import { badRequest, HttpError } from "@/lib/auth/access";
import { createProperty, createRoom, testConnection, type ListingSummary } from "@/lib/dayladau/admin";
import { setPropertyActive, updateProperty } from "@/lib/services/properties";
import { closeRoom, reopenRoom, transferRoom, updateRoom } from "@/lib/services/rooms";
import * as D from "@/lib/domain";

type State = { ok: boolean; error?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const money = (f: FormData, k: string) => Number(s(f, k).replace(/[^\d]/g, "")) || 0;

async function run(fn: Parameters<typeof action>[0]): Promise<State> {
  const r = await action(fn);
  revalidatePath("/properties");
  revalidatePath("/");
  revalidatePath("/reports");
  return r;
}

export async function createPropertyAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => createProperty(getDb(), user, { investorId: s(f, "investorId"), name: s(f, "name"), investmentAmount: money(f, "investmentAmount"), investmentStartMonth: s(f, "investmentStartMonth") }));
}

export async function updatePropertyAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() =>
    updateProperty(getDb(), user, s(f, "propertyId"), {
      name: s(f, "name"), address: s(f, "address") || null, investmentAmount: money(f, "investmentAmount"),
      investmentStartMonth: s(f, "investmentStartMonth") || null, occupancyKpiPct: Number(s(f, "occupancyKpiPct") || 0),
      variableCostPerNight: money(f, "variableCostPerNight"), fixedCostMonthly: money(f, "fixedCostMonthly"),
    }),
  );
}

export async function setPropertyActiveAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => setPropertyActive(getDb(), user, s(f, "propertyId"), s(f, "active") === "1", D.todayVN()));
}

/** Danh sách listing (phòng) Dayladau của chủ đầu tư, đọc từ trang đơn đầu tiên của API. */
export async function listingsAction(investorId: string): Promise<{ ok: boolean; error?: string; listings: ListingSummary[] }> {
  const user = await requireUser();
  try {
    const t = await testConnection(getDb(), user, investorId);
    return { ok: t.ok, error: t.error, listings: t.listings };
  } catch (e) {
    return { ok: false, error: e instanceof HttpError ? e.message : "Lỗi máy chủ", listings: [] };
  }
}

/** Tạo phòng, gắn luôn listing Dayladau nếu có chọn (cùng một giao dịch). */
export async function createRoomAction(input: { propertyId: string; name: string; openedOn: string; listingKey?: string }): Promise<State> {
  const user = await requireUser();
  return run(async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.openedOn)) throw badRequest("Chọn ngày mở bán");
    await createRoom(getDb(), user, { ...input, listingKey: input.listingKey || undefined });
  });
}

export async function renameRoomAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => updateRoom(getDb(), user, s(f, "roomId"), { name: s(f, "name") }));
}

export async function setRoomKpiAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => updateRoom(getDb(), user, s(f, "roomId"), { revenueKpiMonthly: money(f, "revenueKpiMonthly") }));
}

export async function transferRoomAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => transferRoom(getDb(), user, { roomId: s(f, "roomId"), targetPropertyId: s(f, "targetPropertyId") }));
}

export async function closeRoomAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => closeRoom(getDb(), user, s(f, "roomId"), s(f, "closedOn")));
}

export async function reopenRoomAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => reopenRoom(getDb(), user, s(f, "roomId")));
}

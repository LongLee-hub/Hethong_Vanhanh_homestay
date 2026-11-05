"use server";
// Server action cho trang Lương buồng phòng. Quyền Admin kiểm tra trong service.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { action, requireUser } from "@/lib/server";
import { createUser } from "@/lib/services/users";
import { addPayrollAdjustment, deletePayrollAdjustment, payrollRates, savePayrollRates, setHousekeeperPay } from "@/lib/services/payroll";

type State = { ok: boolean; error?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
/** "4.500.000" → 4500000; "-200.000" → -200000. */
const money = (f: FormData, k: string) => {
  const v = s(f, k);
  const n = Number(v.replace(/[^\d]/g, "") || "0");
  return v.startsWith("-") ? -n : n;
};

async function run(fn: Parameters<typeof action>[0]): Promise<State> {
  const r = await action(fn);
  revalidatePath("/payroll");
  return r;
}

export async function createHousekeeperAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(async () => {
    const db = getDb();
    const u = await createUser(db, user, {
      name: s(f, "name"), phone: s(f, "phone"), email: s(f, "email"), role: "HOUSEKEEPER",
      password: String(f.get("password") ?? ""), propertyIds: f.getAll("propertyIds").map(String),
    });
    await setHousekeeperPay(db, user, u.id, money(f, "morningMonthly"), money(f, "eveningMonthly"));
  });
}

export async function setPayAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => setHousekeeperPay(getDb(), user, s(f, "userId"), money(f, "morningMonthly"), money(f, "eveningMonthly")));
}

export async function saveRatesAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(async () => {
    const db = getDb();
    const cur = await payrollRates(db);
    await savePayrollRates(db, user, {
      daysOff: f.get("daysOff") === null ? cur.daysOff : Number(s(f, "daysOff")),
      overtimeRate: money(f, "overtimeRate"),
      fiveStarBonus: money(f, "fiveStarBonus"),
      lowReviewPenalty: money(f, "lowReviewPenalty"),
    });
  });
}

export async function addAdjustmentAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => addPayrollAdjustment(getDb(), user, s(f, "userId"), s(f, "month"), money(f, "amount"), s(f, "reason")));
}

export async function deleteAdjustmentAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => deletePayrollAdjustment(getDb(), user, s(f, "id")));
}

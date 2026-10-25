"use server";
// Server action cho màn hình Chỉ tiêu tháng. Quyền Admin và khóa sổ kiểm tra trong service.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireUser } from "@/lib/server";
import { HttpError } from "@/lib/auth/access";
import { saveTargets, type TargetInput } from "@/lib/services/targets";

type State = { ok: boolean; error?: string; info?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const digits = (v: string) => Number(v.replace(/[^\d]/g, "")) || 0;
const pct = (v: string) => Number(v.replace(",", ".")) || 0;

export async function saveTargetsAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const month = s(f, "month");
  const ids = s(f, "ids").split(",").filter(Boolean);
  const inputs: TargetInput[] = ids.map((id) => ({
    propertyId: id,
    revenue: digits(s(f, `rev:${id}`)),
    occupancyPct: pct(s(f, `occ:${id}`)),
    adr: digits(s(f, `adr:${id}`)),
  }));
  try {
    const r = await saveTargets(getDb(), user, month, inputs);
    revalidatePath("/targets");
    revalidatePath("/");
    const info = r.skippedLocked.length
      ? `Đã lưu. Bỏ qua ${r.skippedLocked.join(", ")} vì tháng này đã khóa sổ.`
      : "Đã lưu chỉ tiêu";
    return { ok: true, info };
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: "Lỗi máy chủ, thử lại sau" };
  }
}

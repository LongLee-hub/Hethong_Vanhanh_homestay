"use server";
// Sửa mẫu checklist dọn phòng. Kiểm tra quyền nằm trong lib/services/checklists.ts.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { action, requireUser } from "@/lib/server";
import { uploadPhoto } from "@/lib/storage";
import { addStep, createOwnTemplate, deleteOwnTemplate, moveStep, removeStep, SAMPLE_FOLDER, updateStep } from "@/lib/services/checklists";

type State = { ok: boolean; error?: string; info?: string } | null;
const scope = (f: FormData) => String(f.get("propertyId") || "") || null;
const file = (f: FormData, name: string) => {
  const v = f.get(name);
  return v instanceof File && v.size > 0 ? v : null;
};
const refresh = () => {
  revalidatePath("/don-dep", "layout");
  revalidatePath("/tasks");
};
const applied = (n: number) => (n ? `Đã lưu, cập nhật ${n} phòng chưa bắt đầu dọn` : "Đã lưu");

async function fields(f: FormData) {
  const photo = file(f, "sample");
  return {
    item: String(f.get("item") ?? ""),
    hint: String(f.get("hint") ?? ""),
    needPhoto: f.get("needPhoto") === "1",
    sample: photo ? await uploadPhoto(photo, SAMPLE_FOLDER) : f.get("removeSample") === "1" ? null : undefined,
  };
}

export async function addStepAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  let n = 0;
  const r = await action(async () => { const v = await fields(f); n = await addStep(getDb(), user, scope(f), { ...v, sample: v.sample ?? null }); });
  refresh();
  return r.ok ? { ok: true, info: applied(n) } : r;
}

export async function updateStepAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  let n = 0;
  const r = await action(async () => { n = await updateStep(getDb(), user, scope(f), String(f.get("stepId")), await fields(f)); });
  refresh();
  return r.ok ? { ok: true, info: applied(n) } : r;
}

export async function removeStepAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => removeStep(getDb(), user, scope(f), String(f.get("stepId"))));
  refresh();
  return r;
}

export async function moveStepAction(f: FormData) {
  const user = await requireUser();
  await moveStep(getDb(), user, scope(f), String(f.get("stepId")), f.get("dir") === "up" ? -1 : 1);
  refresh();
}

export async function createOwnAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => createOwnTemplate(getDb(), user, String(f.get("propertyId"))));
  refresh();
  return r;
}

export async function deleteOwnAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => deleteOwnTemplate(getDb(), user, String(f.get("propertyId"))));
  refresh();
  return r;
}

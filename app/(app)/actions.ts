"use server";
// Server action cho các form. Mọi kiểm tra quyền nằm trong service (lib/services), không dựa vào giao diện.
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { badRequest } from "@/lib/auth/access";
import { rooms } from "@/lib/db/schema";
import { getDb } from "@/lib/db";
import { action, requireUser } from "@/lib/server";
import { uploadPhoto } from "@/lib/storage";
import { saveManualBooking } from "@/lib/services/bookings";
import { createExpense, markPaid, setCommonFinalized } from "@/lib/services/expenses";
import { lockSettlement, unlockSettlement } from "@/lib/services/settlement";
import { addTaskPhoto, clockIn, clockOut, createTask, setTaskStatus, updateChecklist } from "@/lib/services/tasks";

type State = { ok: boolean; error?: string } | null;
const money = (v: FormDataEntryValue | null) => Number(String(v ?? "").replace(/[^\d]/g, ""));
const photo = (f: FormData, name: string) => {
  const v = f.get(name);
  return v instanceof File && v.size > 0 ? v : null;
};

export async function manualBookingAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(async () => {
    const file = photo(f, "proof");
    if (!file) throw badRequest("Bắt buộc có ảnh chuyển khoản");
    const roomId = String(f.get("roomId"));
    // Cơ sở suy ra từ phòng; service kiểm tra lại quyền truy cập cơ sở đó
    const [room] = await getDb().select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    if (!room) throw badRequest("Chọn phòng");
    const url = await uploadPhoto(file, "transfer-proofs");
    await saveManualBooking(getDb(), user, {
      propertyId: room.propertyId, roomId: String(f.get("roomId")), guestName: String(f.get("guestName") ?? ""),
      bookedAt: String(f.get("bookedAt") || "") || undefined, checkIn: String(f.get("checkIn")), checkOut: String(f.get("checkOut")),
      amount: money(f.get("amount")), status: "CONFIRMED", transferProofUrl: url,
    });
  });
  revalidatePath("/bookings");
  return r;
}

export async function expenseAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(async () => {
    const file = photo(f, "receipt");
    const prop = String(f.get("propertyId"));
    await createExpense(getDb(), user, {
      propertyId: prop === "__common" ? null : prop, categoryId: String(f.get("categoryId")), month: String(f.get("month")),
      incurredOn: String(f.get("incurredOn")), amount: money(f.get("amount")), description: String(f.get("description") ?? ""),
      paymentStatus: f.get("paid") ? "PAID" : "UNPAID", receiptUrls: file ? [await uploadPhoto(file, "receipts")] : [],
      taskId: String(f.get("taskId") || "") || null,
    });
  });
  revalidatePath("/expenses");
  return r;
}

export async function markPaidAction(f: FormData) {
  const user = await requireUser();
  await markPaid(getDb(), user, f.getAll("ids").map(String));
  revalidatePath("/expenses");
}

export async function finalizeCommonAction(f: FormData) {
  const user = await requireUser();
  await setCommonFinalized(getDb(), user, String(f.get("month")), f.get("value") === "1");
  revalidatePath("/expenses");
}

export async function lockAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => lockSettlement(getDb(), user, String(f.get("investorId")), String(f.get("month"))));
  revalidatePath("/settlements");
  return r;
}

export async function unlockAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => unlockSettlement(getDb(), user, String(f.get("investorId")), String(f.get("month")), String(f.get("reason") ?? "")));
  revalidatePath("/settlements");
  return r;
}

export async function createTaskAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() =>
    createTask(getDb(), user, {
      propertyId: String(f.get("propertyId")), roomId: String(f.get("roomId") || "") || null, type: String(f.get("type")) as "MAINTENANCE",
      title: String(f.get("title") ?? ""), description: String(f.get("description") ?? ""), assigneeId: String(f.get("assigneeId") || "") || null,
      dueAt: new Date(`${f.get("dueAt")}:00+07:00`), priority: String(f.get("priority") ?? "MEDIUM") as "MEDIUM",
      recurrenceRule: String(f.get("recurrenceRule") || "") || null,
    }),
  );
  revalidatePath("/tasks");
  return r;
}

export async function taskStatusAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => setTaskStatus(getDb(), user, String(f.get("taskId")), String(f.get("status")) as "DONE"));
  revalidatePath("/tasks");
  return r;
}

export async function taskPhotoAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(async () => {
    const file = photo(f, "photo");
    if (!file) throw badRequest("Chọn ảnh nghiệm thu");
    await addTaskPhoto(getDb(), user, String(f.get("taskId")), await uploadPhoto(file, "task-photos"));
  });
  revalidatePath("/tasks");
  return r;
}

export async function checklistAction(f: FormData) {
  const user = await requireUser();
  const items = f.getAll("item").map(String);
  const done = new Set(f.getAll("done").map(String));
  await updateChecklist(getDb(), user, String(f.get("taskId")), items.map((item) => ({ item, done: done.has(item) })));
  revalidatePath("/tasks");
}

export async function clockAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => (f.get("action") === "in" ? clockIn(getDb(), user, String(f.get("propertyId"))) : clockOut(getDb(), user)));
  revalidatePath("/attendance");
  return r;
}

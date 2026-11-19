"use server";
// Server action cho màn Dọn phòng và Daily report. Kiểm tra quyền nằm trong lib/services/cleaning.ts.
import { revalidatePath } from "next/cache";
import { badRequest } from "@/lib/auth/access";
import { getDb } from "@/lib/db";
import { action, requireUser } from "@/lib/server";
import { uploadPhoto } from "@/lib/storage";
import { defaultSender, markNotificationsRead, notifyUsers } from "@/lib/services/notify";
import { assignIssue, completeCleaning, reportIssue, resolveIssue, setChecklistPhoto, toggleChecklistItem } from "@/lib/services/cleaning";

type State = { ok: boolean; error?: string } | null;
const file = (f: FormData, name: string) => {
  const v = f.get(name);
  return v instanceof File && v.size > 0 ? v : null;
};
const refresh = (taskId?: string) => {
  revalidatePath("/don-dep");
  if (taskId) revalidatePath(`/don-dep/${taskId}`);
  revalidatePath("/daily-report");
  revalidatePath("/tasks");
};

export async function toggleItemAction(f: FormData) {
  const user = await requireUser();
  const taskId = String(f.get("taskId"));
  await toggleChecklistItem(getDb(), user, taskId, Number(f.get("index")), f.get("done") === "1");
  refresh(taskId);
}

export async function itemPhotoAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const taskId = String(f.get("taskId"));
  const r = await action(async () => {
    const photo = file(f, "photo");
    if (!photo) throw badRequest("Chưa có ảnh");
    await setChecklistPhoto(getDb(), user, taskId, Number(f.get("index")), await uploadPhoto(photo, "cleaning"));
  });
  refresh(taskId);
  return r;
}

export async function completeCleaningAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const taskId = String(f.get("taskId"));
  const r = await action(() => completeCleaning(getDb(), user, taskId));
  refresh(taskId);
  return r;
}

export async function reportIssueAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(async () => {
    const photo = file(f, "photo");
    await reportIssue(getDb(), user, {
      propertyId: String(f.get("propertyId")), roomId: String(f.get("roomId") || "") || null, category: String(f.get("category") ?? ""),
      description: String(f.get("description") ?? ""), photoUrl: photo ? await uploadPhoto(photo, "issues") : null,
    });
  });
  refresh();
  revalidatePath("/don-dep/su-co");
  return r;
}

export async function assignIssueAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => assignIssue(getDb(), user, String(f.get("issueId")), String(f.get("assigneeId") || "") || null));
  refresh();
  revalidatePath("/don-dep/su-co");
  return r;
}

export async function resolveIssueAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  const r = await action(() => resolveIssue(getDb(), user, String(f.get("issueId")), String(f.get("note") ?? "")));
  refresh();
  revalidatePath("/don-dep/su-co");
  return r;
}

export async function markReadAction(f: FormData) {
  const user = await requireUser();
  await markNotificationsRead(getDb(), user, String(f.get("id") || "") || undefined);
  revalidatePath("/don-dep");
}

/** Gửi một thông báo thử tới các máy đã bật nhận của chính mình. */
export async function testPushAction(): Promise<{ ok: boolean; error?: string; info?: string }> {
  const user = await requireUser();
  const sender = defaultSender();
  if (!sender) return { ok: false, error: "Máy chủ chưa cấu hình khóa VAPID nên chưa gửi được thông báo đẩy" };
  const r = await notifyUsers(getDb(), [user.id], { key: `TEST:${Date.now()}`, title: "Thông báo thử", body: "Điện thoại này sẽ nhận cảnh báo dọn phòng.", url: "/don-dep" }, sender);
  revalidatePath("/don-dep");
  return r.pushed ? { ok: true, info: "Đã gửi, kiểm tra thông báo trên điện thoại" } : { ok: false, error: "Chưa có máy nào bật nhận thông báo cho tài khoản này" };
}

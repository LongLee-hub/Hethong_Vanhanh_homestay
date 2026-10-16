"use server";
// Server action cho màn hình Tài khoản. Quyền Admin kiểm tra trong service.
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { action, requireUser } from "@/lib/server";
import type { Role } from "@/lib/auth/access";
import { createUser, resetPassword, setUserActive, setUserProperties, updateUser } from "@/lib/services/users";

type State = { ok: boolean; error?: string } | null;
const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const ids = (f: FormData) => f.getAll("propertyIds").map(String);

async function run(fn: Parameters<typeof action>[0]): Promise<State> {
  const r = await action(fn);
  revalidatePath("/users");
  return r;
}

export async function createUserAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() =>
    createUser(getDb(), user, {
      name: s(f, "name"), phone: s(f, "phone"), email: s(f, "email"), role: s(f, "role") as Role,
      password: String(f.get("password") ?? ""), propertyIds: ids(f), investorId: s(f, "investorId") || null,
    }),
  );
}

export async function updateUserAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => updateUser(getDb(), user, s(f, "userId"), { name: s(f, "name"), phone: s(f, "phone"), email: s(f, "email") }));
}

export async function setUserPropertiesAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => setUserProperties(getDb(), user, s(f, "userId"), ids(f)));
}

export async function resetPasswordAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => resetPassword(getDb(), user, s(f, "userId"), String(f.get("password") ?? "")));
}

export async function setUserActiveAction(_: State, f: FormData): Promise<State> {
  const user = await requireUser();
  return run(() => setUserActive(getDb(), user, s(f, "userId"), s(f, "active") === "1"));
}

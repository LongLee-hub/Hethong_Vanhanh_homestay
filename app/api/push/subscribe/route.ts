// POST: lưu đăng ký nhận thông báo đẩy của máy đang dùng. DELETE: tắt nhận trên máy này.
import { getDb } from "@/lib/db";
import { api } from "@/lib/server";
import { removeSubscription, saveSubscription } from "@/lib/services/notify";

export const POST = api(async ({ user, req }) => {
  const body = (await req.json().catch(() => null)) as { subscription?: unknown } | null;
  await saveSubscription(getDb(), user, body?.subscription, req.headers.get("user-agent"));
  return { ok: true };
});

export const DELETE = api(async ({ user, req }) => {
  const body = (await req.json().catch(() => null)) as { endpoint?: string } | null;
  if (body?.endpoint) await removeSubscription(getDb(), user, body.endpoint);
  return { ok: true };
});

// Thông báo tới tài khoản nhân viên: lưu vào hộp thông báo trong app và đẩy (Web Push) tới điện thoại đã bật nhận.
// Web Push cần cặp khóa VAPID: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (tạo bằng `npx web-push generate-vapid-keys`)
// và VAPID_SUBJECT (mailto:… hoặc địa chỉ app). Chưa đặt khóa thì vẫn lưu hộp thông báo, chỉ không đẩy.
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import webpush from "web-push";
import type { DB } from "../db";
import { notifications, pushSubscriptions, userPropertyAccess, users } from "../db/schema";
import { badRequest, type SessionUser } from "../auth/access";

export interface NoticeInput {
  /** Khóa sự việc: cùng khóa thì mỗi người chỉ nhận một lần. */
  key: string;
  title: string;
  body: string;
  url?: string;
  propertyId?: string;
  urgent?: boolean;
}

export interface PushTarget { endpoint: string; keys: { p256dh: string; auth: string } }
/** Hàm gửi một push; trả mã HTTP lỗi (404/410 = máy đã hủy đăng ký) bằng cách ném lỗi có statusCode. Test truyền hàm giả. */
export type PushSender = (target: PushTarget, payload: string) => Promise<void>;

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY?.trim() || null;

let configured = false;
/** Gửi push thật qua web-push; null khi chưa cấu hình VAPID. */
export function defaultSender(): PushSender | null {
  const pub = vapidPublicKey();
  const priv = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!pub || !priv) return null;
  if (!configured) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:admin@baocaodau.com", pub, priv);
    configured = true;
  }
  return async (target, payload) => {
    await webpush.sendNotification(target, payload, { TTL: 60 * 60, urgency: "high" });
  };
}

/** Nhân viên dọn dẹp chính của cơ sở: buồng phòng đang hoạt động được giao cơ sở đó (không tính người sang ca hỗ trợ). */
export async function mainHousekeepers(db: DB, propertyId: string): Promise<string[]> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userPropertyAccess, eq(userPropertyAccess.userId, users.id))
    .where(and(eq(users.role, "HOUSEKEEPER"), eq(users.active, true), eq(userPropertyAccess.propertyId, propertyId)));
  return rows.map((r) => r.id);
}

/**
 * Gửi thông báo cho danh sách người dùng. Người đã nhận khóa này rồi thì bỏ qua (không gửi trùng).
 * Trả số người nhận mới và số máy đã đẩy được.
 */
export async function notifyUsers(db: DB, userIds: string[], n: NoticeInput, sender: PushSender | null = defaultSender()) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return { notified: 0, pushed: 0 };
  const fresh = await db
    .insert(notifications)
    .values(ids.map((userId) => ({ userId, key: n.key, title: n.title, body: n.body, url: n.url ?? null, propertyId: n.propertyId ?? null, urgent: !!n.urgent })))
    .onConflictDoNothing({ target: [notifications.userId, notifications.key] })
    .returning({ id: notifications.id, userId: notifications.userId });
  let pushed = 0;
  if (sender && fresh.length) {
    const subs = await db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, fresh.map((f) => f.userId)));
    for (const f of fresh) {
      const mine = subs.filter((s) => s.userId === f.userId);
      let ok = false;
      for (const s of mine) {
        const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url ?? "/don-dep", tag: n.key, urgent: !!n.urgent, id: f.id });
        try {
          await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          await db.update(pushSubscriptions).set({ lastSentAt: new Date() }).where(eq(pushSubscriptions.id, s.id));
          ok = true;
          pushed++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          // Máy đã gỡ app / tắt thông báo: xóa đăng ký để lần sau khỏi gửi
          if (code === 404 || code === 410) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
          else console.error("Gửi push lỗi", code ?? (e as Error).message);
        }
      }
      if (ok) await db.update(notifications).set({ pushedAt: new Date() }).where(eq(notifications.id, f.id));
    }
  }
  return { notified: fresh.length, pushed };
}

/** Lưu đăng ký nhận push của máy đang dùng (một máy chỉ gắn với một tài khoản: đăng nhập tài khoản khác thì chuyển sang). */
export async function saveSubscription(db: DB, user: SessionUser, sub: unknown, userAgent: string | null) {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = typeof s?.endpoint === "string" ? s.endpoint : "";
  const p256dh = typeof s?.keys?.p256dh === "string" ? s.keys.p256dh : "";
  const auth = typeof s?.keys?.auth === "string" ? s.keys.auth : "";
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) throw badRequest("Đăng ký nhận thông báo không hợp lệ");
  await db
    .insert(pushSubscriptions)
    .values({ userId: user.id, endpoint, p256dh, auth, userAgent: userAgent?.slice(0, 300) ?? null })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: user.id, p256dh, auth, userAgent: userAgent?.slice(0, 300) ?? null } });
}

export async function removeSubscription(db: DB, user: SessionUser, endpoint: string) {
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.userId, user.id), eq(pushSubscriptions.endpoint, endpoint)));
}

export async function subscriptionCount(db: DB, user: SessionUser) {
  return (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id))).length;
}

/** Thông báo của chính người dùng, mới nhất trước. */
export async function myNotifications(db: DB, user: SessionUser, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, user.id), opts.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 20);
}

/** Đánh dấu đã xem: một thông báo, hoặc tất cả khi không truyền id. Chỉ đụng thông báo của chính mình. */
export async function markNotificationsRead(db: DB, user: SessionUser, id?: string) {
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt), id ? eq(notifications.id, id) : undefined));
}

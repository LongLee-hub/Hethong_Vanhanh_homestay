// Cài đặt hệ thống, mã hóa token, gửi Lark.
import { cache } from "react";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DB } from "../db";
import { settings } from "../db/schema";

export const DEFAULTS: Record<string, string> = {
  managementFeePct: "20",
  syncTime: "06:00",
  larkWebhookUrl: "",
  // TODO(CONFIRM): tỷ lệ hoa hồng thực tế từng kênh; chỉ dùng khi API Dayladau không trả hoa hồng
  "commission.Airbnb": "15",
  "commission.Booking": "15",
  "commission.Agoda": "18",
  "commission.Direct": "0",
  cleaningDueHour: "14:00",
};

export async function getSetting(db: DB, key: string): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  return row?.value ?? DEFAULTS[key] ?? "";
}

export async function getAllSettings(db: DB): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export async function setSetting(db: DB, key: string, value: string) {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

// cache: trang Tổng quan tính cho từng NĐT, mỗi NĐT đều cần tỷ lệ phí; chỉ đọc một lần mỗi lượt dựng trang
export const feePct = cache(async (db: DB): Promise<number> => {
  const n = Number(await getSetting(db, "managementFeePct"));
  return Number.isFinite(n) ? n : 20;
});

// ---- Mã hóa token Dayladau (AES-256-GCM) ----
function key(): Buffer {
  const k = process.env.TOKEN_ENCRYPTION_KEY;
  if (!k) throw new Error("Thiếu TOKEN_ENCRYPTION_KEY (32 byte, dạng base64)");
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY phải là 32 byte base64");
  return buf;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(payload: string): string {
  const [iv, tag, enc] = payload.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

// ---- Lark ----
export type LarkSender = (url: string, body: unknown) => Promise<boolean | void>;

/** Gửi tới webhook bot Lark. Lỗi mạng chỉ ghi log, không làm hỏng thao tác chính. */
export const postLark: LarkSender = async (url, body) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text().catch(() => "");
    // Lark trả HTTP 200 kèm code ≠ 0 khi webhook sai / bot bị gỡ khỏi nhóm
    const code = (() => { try { return JSON.parse(text).code ?? JSON.parse(text).StatusCode ?? 0; } catch { return 0; } })();
    if (!r.ok || code !== 0) {
      console.error("Gửi Lark lỗi", r.status, text.slice(0, 300));
      return false;
    }
    return true;
  } catch (e) {
    console.error("Gửi Lark lỗi", e);
    return false;
  }
};

export async function notifyLark(db: DB, text: string) {
  const url = await getSetting(db, "larkWebhookUrl");
  if (!url) return;
  await postLark(url, { msg_type: "text", content: { text } });
}

// Cài đặt hệ thống, mã hóa token, gửi Lark.
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

export async function feePct(db: DB): Promise<number> {
  const n = Number(await getSetting(db, "managementFeePct"));
  return Number.isFinite(n) ? n : 20;
}

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
export async function notifyLark(db: DB, text: string) {
  const url = await getSetting(db, "larkWebhookUrl");
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg_type: "text", content: { text } }) });
  } catch (e) {
    console.error("Gửi Lark lỗi", e);
  }
}

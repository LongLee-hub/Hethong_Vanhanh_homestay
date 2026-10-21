// Cấu hình đăng nhập Google để đọc Gmail. Admin điền ngay trên web (trang Payout Airbnb → Cài đặt Google);
// biến môi trường GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / APP_URL nếu có thì được ưu tiên.
// Client Secret lưu mã hóa AES-256-GCM trong bảng settings, không bao giờ trả ra trình duyệt.
import type { DB } from "../db";
import { badRequest, requirePermission, type SessionUser } from "../auth/access";
import { decryptSecret, encryptSecret, getAllSettings, setSetting } from "../services/settings";

export const KEY_CLIENT_ID = "google.clientId";
export const KEY_CLIENT_SECRET = "google.clientSecret"; // đã mã hóa
export const KEY_APP_URL = "appUrl";

export interface GoogleConfig {
  clientId: string | null;
  clientSecret: string | null;
  appUrl: string | null;
  redirectUri: string | null;
}

export interface GoogleSetup {
  clientId: string | null;
  hasSecret: boolean;
  secretHint: string | null; // 4 ký tự cuối
  appUrl: string | null;
  /** Ô nào đang lấy từ biến môi trường (không sửa được trên web). */
  fromEnv: { clientId: boolean; clientSecret: boolean; appUrl: boolean };
  /** Secret đã lưu nhưng không giải mã được (đổi TOKEN_ENCRYPTION_KEY) → cần nhập lại. */
  secretBroken: boolean;
}

const env = (k: string) => process.env[k]?.trim() || null;

function readSecret(enc: string | undefined, decrypt: (s: string) => string): { value: string | null; broken: boolean } {
  if (!enc) return { value: null, broken: false };
  try {
    return { value: decrypt(enc), broken: false };
  } catch {
    return { value: null, broken: true };
  }
}

export async function loadGoogleConfig(db: DB, decrypt = decryptSecret): Promise<GoogleConfig> {
  const s = await getAllSettings(db);
  return {
    clientId: env("GOOGLE_CLIENT_ID") ?? (s[KEY_CLIENT_ID] || null),
    clientSecret: env("GOOGLE_CLIENT_SECRET") ?? readSecret(s[KEY_CLIENT_SECRET], decrypt).value,
    appUrl: env("APP_URL") ?? (s[KEY_APP_URL] || null),
    redirectUri: env("GOOGLE_REDIRECT_URI"),
  };
}

export const googleReady = (c: GoogleConfig) => !!(c.clientId && c.clientSecret);

export async function googleSetup(db: DB, user: SessionUser, decrypt = decryptSecret): Promise<GoogleSetup> {
  requirePermission(user, "admin");
  const s = await getAllSettings(db);
  const fromEnv = { clientId: !!env("GOOGLE_CLIENT_ID"), clientSecret: !!env("GOOGLE_CLIENT_SECRET"), appUrl: !!env("APP_URL") };
  const stored = readSecret(s[KEY_CLIENT_SECRET], decrypt);
  const secret = fromEnv.clientSecret ? env("GOOGLE_CLIENT_SECRET") : stored.value;
  return {
    clientId: env("GOOGLE_CLIENT_ID") ?? (s[KEY_CLIENT_ID] || null),
    hasSecret: !!secret,
    secretHint: secret ? "…" + secret.slice(-4) : null,
    appUrl: env("APP_URL") ?? (s[KEY_APP_URL] || null),
    fromEnv,
    secretBroken: !fromEnv.clientSecret && stored.broken,
  };
}

const CLIENT_ID_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;

/** Địa chỉ gốc của app: chỉ giao thức + tên miền (+ cổng), bỏ dấu / cuối. */
export function normalizeAppUrl(v: string): string {
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw badRequest("Địa chỉ app không hợp lệ, ví dụ https://app.loci.vn");
  }
  if (!/^https?:$/.test(u.protocol)) throw badRequest("Địa chỉ app phải bắt đầu bằng https://");
  if (u.protocol === "http:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw badRequest("Google chỉ chấp nhận https:// (trừ localhost)");
  if (u.pathname !== "/" || u.search || u.hash) throw badRequest("Chỉ nhập địa chỉ gốc, không kèm đường dẫn, ví dụ https://app.loci.vn");
  return u.origin;
}

/** Lưu cấu hình Google từ form. Secret để trống = giữ secret cũ. Ô lấy từ biến môi trường thì bỏ qua. */
export async function saveGoogleSetup(
  db: DB,
  user: SessionUser,
  input: { clientId: string; clientSecret: string; appUrl: string },
  encrypt = encryptSecret,
) {
  requirePermission(user, "admin");
  const clientId = input.clientId.trim();
  const secret = input.clientSecret.trim();
  // Kiểm tra hết rồi mới ghi, để lỗi ở một ô không làm lưu dở các ô khác
  if (!env("GOOGLE_CLIENT_ID") && !CLIENT_ID_RE.test(clientId)) throw badRequest("Client ID có dạng …apps.googleusercontent.com");
  if (!env("GOOGLE_CLIENT_SECRET")) {
    if (secret && !/^[\w-]{10,}$/.test(secret)) throw badRequest("Client Secret không hợp lệ (thường bắt đầu bằng GOCSPX-)");
    if (!secret && !(await getAllSettings(db))[KEY_CLIENT_SECRET]) throw badRequest("Nhập Client Secret");
  }
  const appUrl = env("APP_URL") ? null : input.appUrl.trim() ? normalizeAppUrl(input.appUrl) : "";
  if (!env("GOOGLE_CLIENT_ID")) await setSetting(db, KEY_CLIENT_ID, clientId);
  if (!env("GOOGLE_CLIENT_SECRET") && secret) await setSetting(db, KEY_CLIENT_SECRET, encrypt(secret));
  if (appUrl !== null) await setSetting(db, KEY_APP_URL, appUrl);
}

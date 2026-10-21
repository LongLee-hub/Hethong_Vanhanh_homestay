// Đăng nhập Google (OAuth 2.0, luồng web) để đọc Gmail chỉ-đọc. Không dùng thư viện googleapis, gọi thẳng REST.
// Cần GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET; địa chỉ quay về mặc định là <origin>/api/gmail/callback.
import { SignJWT, jwtVerify } from "jose";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL = "15m";

export function gmailConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function creds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Chưa cấu hình GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET");
  return { id, secret };
}

/** Địa chỉ Google gọi lại sau khi người dùng đồng ý. Phải khai báo y hệt trong Google Cloud Console. */
export function redirectUri(origin: string): string {
  return process.env.GOOGLE_REDIRECT_URI || `${origin.replace(/\/$/, "")}/api/gmail/callback`;
}

function stateKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET phải dài ít nhất 32 ký tự");
  return new TextEncoder().encode(`gmail-oauth:${s}`);
}

export interface OAuthState {
  userId: string;
  investorId: string;
}

/** state ký bằng SESSION_SECRET: chống giả mạo yêu cầu và gắn lượt kết nối với đúng người bấm + đúng NĐT. */
export async function signState(s: OAuthState): Promise<string> {
  return new SignJWT({ inv: s.investorId }).setProtectedHeader({ alg: "HS256" }).setSubject(s.userId).setIssuedAt().setExpirationTime(STATE_TTL).sign(stateKey());
}

export async function verifyState(token: string | null): Promise<OAuthState | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, stateKey());
    if (!payload.sub || typeof payload.inv !== "string") return null;
    return { userId: payload.sub, investorId: payload.inv };
  } catch {
    return null;
  }
}

export function authUrl(origin: string, state: string): string {
  const p = new URLSearchParams({
    client_id: creds().id,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: `openid email ${GMAIL_SCOPE}`,
    access_type: "offline", // để nhận refresh token, job tự đọc thư hằng ngày
    prompt: "consent", // buộc Google trả refresh token cả khi đã từng đồng ý
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = String(json.error ?? res.status);
    // invalid_grant: người dùng thu hồi quyền, đổi mật khẩu, hoặc app Google còn ở chế độ Testing (token hết hạn sau 7 ngày)
    throw new Error(err === "invalid_grant" ? "Google từ chối quyền truy cập (invalid_grant) — cần kết nối lại Gmail" : `Google OAuth lỗi: ${err}`);
  }
  return json;
}

/** Đổi mã ủy quyền lấy refresh token + email của hộp thư. */
export async function exchangeCode(origin: string, code: string): Promise<{ refreshToken: string; email: string; scope: string }> {
  const { id, secret } = creds();
  const t = await tokenRequest({ code, client_id: id, client_secret: secret, redirect_uri: redirectUri(origin), grant_type: "authorization_code" });
  const refreshToken = String(t.refresh_token ?? "");
  if (!refreshToken) throw new Error("Google không trả refresh token — vào myaccount.google.com/permissions gỡ quyền của app rồi kết nối lại");
  const email = emailFromIdToken(String(t.id_token ?? ""));
  if (!email) throw new Error("Không đọc được địa chỉ Gmail");
  return { refreshToken, email, scope: String(t.scope ?? "") };
}

export async function accessToken(refreshToken: string): Promise<string> {
  const { id, secret } = creds();
  const t = await tokenRequest({ refresh_token: refreshToken, client_id: id, client_secret: secret, grant_type: "refresh_token" });
  return String(t.access_token);
}

/** id_token đến thẳng từ máy chủ Google qua HTTPS nên chỉ cần đọc phần payload, không phải kiểm chữ ký. */
function emailFromIdToken(idToken: string): string | null {
  const part = idToken.split(".")[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Địa chỉ gốc của app. Chạy sau nginx trên VPS thì req.url có thể là localhost, nên ưu tiên APP_URL rồi tới header proxy. */
export function appOrigin(req: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto.split(",")[0]}://${host.split(",")[0]}`;
}

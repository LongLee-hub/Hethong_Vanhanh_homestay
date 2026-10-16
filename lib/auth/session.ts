// Phiên đăng nhập: JWT ký HS256 trong cookie httpOnly, sống 30 ngày (nhân viên dùng điện thoại).
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { eq, or } from "drizzle-orm";
import type { DB } from "../db";
import { users } from "../db/schema";
import { HttpError, type SessionUser } from "./access";

export const SESSION_COOKIE = "loci_session";
const MAX_AGE = 60 * 60 * 24 * 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET phải dài ít nhất 32 ký tự");
  return new TextEncoder().encode(s);
}

export async function createSessionToken(user: SessionUser): Promise<string> {
  return new SignJWT({ name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

export async function readSessionToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return { id: String(payload.sub), name: String(payload.name), role: payload.role as SessionUser["role"] };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: MAX_AGE,
};

/** Đăng nhập bằng số điện thoại hoặc email. */
export async function verifyLogin(db: DB, login: string, password: string): Promise<SessionUser> {
  const key = login.trim().toLowerCase();
  const [u] = await db.select().from(users).where(or(eq(users.phone, normalizePhone(key)), eq(users.email, key))).limit(1);
  if (!u || !u.active || !(await bcrypt.compare(password, u.passwordHash))) {
    throw new HttpError(401, "Sai số điện thoại/email hoặc mật khẩu");
  }
  return { id: u.id, name: u.name, role: u.role };
}

/** Đọc lại người dùng từ DB để chặn tài khoản đã bị khóa dù token còn hạn. */
export async function refreshUser(db: DB, s: SessionUser | null): Promise<SessionUser | null> {
  if (!s) return null;
  const [u] = await db.select().from(users).where(eq(users.id, s.id)).limit(1);
  if (!u || !u.active) return null;
  return { id: u.id, name: u.name, role: u.role };
}

/** Số điện thoại lưu dạng chỉ chữ số (giữ dấu + đầu), để đăng nhập "0912 345 678" hay "0912.345.678" đều khớp. */
export const normalizePhone = (p: string) => p.trim().replace(/(?!^\+)[^\d]/g, "");

export const hashPassword = (p: string) => bcrypt.hash(p, 10);

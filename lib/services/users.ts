// Quản lý tài khoản (chỉ Admin): tạo tài khoản theo vai trò, sửa thông tin, đặt lại mật khẩu, khóa / mở khóa.
// NĐT gắn với một bản ghi investors (xem cơ sở mình sở hữu); Quản lý / Kế toán / Buồng phòng gắn với danh sách cơ sở.
import { and, asc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { DB } from "../db";
import { investors, properties, userPropertyAccess, users } from "../db/schema";
import { badRequest, notFound, requirePermission, type Role, type SessionUser } from "../auth/access";
import { hashPassword, normalizePhone } from "../auth/session";

export const ROLES: Role[] = ["ADMIN", "INVESTOR", "MANAGER", "ACCOUNTANT", "HOUSEKEEPER"];
/** Vai trò được giao theo cơ sở (bảng user_property_access). */
export const STAFF_ROLES: Role[] = ["MANAGER", "ACCOUNTANT", "HOUSEKEEPER"];
export const MIN_PASSWORD = 8;

export interface UserInput {
  name: string;
  phone?: string | null;
  email?: string | null;
}

export interface CreateUserInput extends UserInput {
  role: Role;
  password: string;
  propertyIds?: string[];
  /** NĐT: id chủ đầu tư có sẵn chưa có tài khoản; bỏ trống thì tạo chủ đầu tư mới cùng tên. */
  investorId?: string | null;
}

export async function listUsers(db: DB, user: SessionUser) {
  requirePermission(user, "admin");
  const [us, access, invs] = await Promise.all([
    db.select({ id: users.id, name: users.name, phone: users.phone, email: users.email, role: users.role, active: users.active, createdAt: users.createdAt })
      .from(users).orderBy(asc(users.name)),
    db.select().from(userPropertyAccess),
    db.select({ id: investors.id, name: investors.name, userId: investors.userId }).from(investors),
  ]);
  return us.map((u) => ({
    ...u,
    propertyIds: access.filter((a) => a.userId === u.id).map((a) => a.propertyId),
    investor: invs.find((i) => i.userId === u.id) ?? null,
  }));
}

/** Chủ đầu tư chưa gắn tài khoản đăng nhập. */
export async function investorsWithoutAccount(db: DB, user: SessionUser) {
  requirePermission(user, "admin");
  return db.select({ id: investors.id, name: investors.name }).from(investors).where(isNull(investors.userId)).orderBy(asc(investors.name));
}

async function cleanContact(db: DB, input: UserInput, exceptId?: string) {
  const name = input.name.trim();
  const phone = input.phone ? normalizePhone(input.phone) || null : null;
  const email = input.email?.trim().toLowerCase() || null;
  if (!name) throw badRequest("Nhập họ tên");
  if (!phone && !email) throw badRequest("Nhập số điện thoại hoặc email để đăng nhập");
  if (phone && !/^\+?\d{9,15}$/.test(phone)) throw badRequest("Số điện thoại không hợp lệ");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("Email không hợp lệ");
  const keys = [phone && eq(users.phone, phone), email && eq(users.email, email)].filter((x) => !!x);
  const dup = await db
    .select({ phone: users.phone, email: users.email })
    .from(users)
    .where(exceptId ? and(or(...keys), ne(users.id, exceptId)) : or(...keys))
    .limit(1);
  if (dup.length) throw badRequest(dup[0].phone && dup[0].phone === phone ? "Số điện thoại đã có tài khoản" : "Email đã có tài khoản");
  return { name, phone, email };
}

function checkPassword(p: string) {
  if (p.length < MIN_PASSWORD) throw badRequest(`Mật khẩu cần ít nhất ${MIN_PASSWORD} ký tự`);
}

async function checkProperties(db: DB, ids: string[]) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) throw badRequest("Chọn ít nhất một cơ sở");
  const found = await db.select({ id: properties.id }).from(properties).where(inArray(properties.id, uniq));
  if (found.length !== uniq.length) throw notFound("Không tìm thấy cơ sở");
  return uniq;
}

export async function createUser(db: DB, user: SessionUser, input: CreateUserInput) {
  requirePermission(user, "admin");
  if (!ROLES.includes(input.role)) throw badRequest("Chọn vị trí");
  const contact = await cleanContact(db, input);
  checkPassword(input.password);
  const staff = STAFF_ROLES.includes(input.role);
  const propertyIds = staff ? await checkProperties(db, input.propertyIds ?? []) : [];
  const passwordHash = await hashPassword(input.password);

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(users).values({ ...contact, role: input.role, passwordHash }).returning({ id: users.id, name: users.name, role: users.role });
    if (staff) await tx.insert(userPropertyAccess).values(propertyIds.map((propertyId) => ({ userId: row.id, propertyId })));
    if (input.role === "INVESTOR") {
      if (input.investorId) {
        // Chỉ gắn khi chủ đầu tư chưa có tài khoản, tránh cướp quyền xem số của NĐT khác
        const linked = await tx.update(investors).set({ userId: row.id }).where(and(eq(investors.id, input.investorId), isNull(investors.userId))).returning({ id: investors.id });
        if (!linked.length) throw badRequest("Chủ đầu tư không tồn tại hoặc đã có tài khoản");
      } else {
        await tx.insert(investors).values({ name: contact.name, userId: row.id });
      }
    }
    return row;
  });
}

export async function updateUser(db: DB, user: SessionUser, userId: string, input: UserInput) {
  requirePermission(user, "admin");
  const contact = await cleanContact(db, input, userId);
  const [row] = await db.update(users).set(contact).where(eq(users.id, userId)).returning({ id: users.id });
  if (!row) throw notFound("Không tìm thấy tài khoản");
  return row;
}

export async function setUserProperties(db: DB, user: SessionUser, userId: string, propertyIds: string[]) {
  requirePermission(user, "admin");
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u) throw notFound("Không tìm thấy tài khoản");
  if (!STAFF_ROLES.includes(u.role)) throw badRequest("Vị trí này không giao theo cơ sở");
  const ids = await checkProperties(db, propertyIds);
  await db.transaction(async (tx) => {
    await tx.delete(userPropertyAccess).where(eq(userPropertyAccess.userId, userId));
    await tx.insert(userPropertyAccess).values(ids.map((propertyId) => ({ userId, propertyId })));
  });
}

export async function resetPassword(db: DB, user: SessionUser, userId: string, password: string) {
  requirePermission(user, "admin");
  checkPassword(password);
  const [row] = await db.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, userId)).returning({ id: users.id });
  if (!row) throw notFound("Không tìm thấy tài khoản");
}

/** Khóa tài khoản: refreshUser đọc lại DB mỗi lượt tải nên phiên đang mở bị đăng xuất ngay. */
export async function setUserActive(db: DB, user: SessionUser, userId: string, active: boolean) {
  requirePermission(user, "admin");
  if (!active && userId === user.id) throw badRequest("Không thể tự khóa tài khoản của mình");
  if (!active) {
    const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    if (u?.role === "ADMIN") {
      const others = await db.select({ id: users.id }).from(users).where(and(eq(users.role, "ADMIN"), eq(users.active, true), ne(users.id, userId))).limit(1);
      if (!others.length) throw badRequest("Cần giữ ít nhất một Admin đang hoạt động");
    }
  }
  const [row] = await db.update(users).set({ active }).where(eq(users.id, userId)).returning({ id: users.id });
  if (!row) throw notFound("Không tìm thấy tài khoản");
}

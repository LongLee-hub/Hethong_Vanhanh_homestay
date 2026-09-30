// Xác thực và phân quyền. Mọi truy vấn có property_id PHẢI lọc qua allowedPropertyIds (Đặc tả mục 2).
import { and, eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { investors, properties, userPropertyAccess } from "../db/schema";

export type Role = "ADMIN" | "INVESTOR" | "MANAGER" | "ACCOUNTANT" | "HOUSEKEEPER";
export interface SessionUser {
  id: string;
  name: string;
  role: Role;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const forbidden = (msg = "Bạn không có quyền thực hiện thao tác này") => new HttpError(403, msg);
export const notFound = (msg = "Không tìm thấy") => new HttpError(404, msg);
export const badRequest = (msg: string) => new HttpError(400, msg);

/** Danh sách quyền theo vai trò (bảng mục 2). */
const PERMS = {
  viewFinance: ["ADMIN", "INVESTOR", "MANAGER", "ACCOUNTANT"],
  viewFee: ["ADMIN", "INVESTOR", "ACCOUNTANT"],
  viewBookings: ["ADMIN", "INVESTOR", "MANAGER", "ACCOUNTANT", "HOUSEKEEPER"],
  viewBookingAmounts: ["ADMIN", "INVESTOR", "MANAGER", "ACCOUNTANT"],
  createManualBooking: ["ADMIN", "MANAGER", "ACCOUNTANT"],
  editExpense: ["ADMIN", "ACCOUNTANT"],
  markPaid: ["ADMIN", "ACCOUNTANT"],
  declareCommon: ["ADMIN", "ACCOUNTANT"],
  assignTask: ["ADMIN", "MANAGER"],
  workTask: ["ADMIN", "MANAGER", "ACCOUNTANT", "HOUSEKEEPER"],
  approveChecklist: ["MANAGER", "ADMIN"],
  clock: ["MANAGER", "ACCOUNTANT", "HOUSEKEEPER"],
  viewAllAttendance: ["ADMIN", "MANAGER", "ACCOUNTANT"],
  lockSettlement: ["ADMIN"],
  admin: ["ADMIN"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMS;

export function can(user: SessionUser, p: Permission): boolean {
  return (PERMS[p] as readonly Role[]).includes(user.role);
}

export function requirePermission(user: SessionUser, p: Permission) {
  if (!can(user, p)) throw forbidden();
}

/** Các cơ sở người dùng được truy cập. NĐT: đúng các cơ sở mình sở hữu. */
export async function allowedPropertyIds(db: DB, user: SessionUser): Promise<string[]> {
  if (user.role === "ADMIN") {
    return (await db.select({ id: properties.id }).from(properties)).map((r) => r.id);
  }
  if (user.role === "INVESTOR") {
    const rows = await db
      .select({ id: properties.id })
      .from(properties)
      .innerJoin(investors, eq(investors.id, properties.investorId))
      .where(eq(investors.userId, user.id));
    return rows.map((r) => r.id);
  }
  const rows = await db.select({ id: userPropertyAccess.propertyId }).from(userPropertyAccess).where(eq(userPropertyAccess.userId, user.id));
  return rows.map((r) => r.id);
}

export async function assertPropertyAccess(db: DB, user: SessionUser, propertyId: string) {
  const ids = await allowedPropertyIds(db, user);
  // Trả 404 thay vì 403 để không tiết lộ cơ sở của người khác có tồn tại
  if (!ids.includes(propertyId)) throw notFound("Không tìm thấy cơ sở");
}

/** NĐT mà người dùng được xem quyết toán. */
export async function allowedInvestorIds(db: DB, user: SessionUser): Promise<string[]> {
  if (!can(user, "viewFee")) return [];
  if (user.role === "INVESTOR") {
    return (await db.select({ id: investors.id }).from(investors).where(eq(investors.userId, user.id))).map((r) => r.id);
  }
  const pids = await allowedPropertyIds(db, user);
  if (!pids.length) return [];
  const rows = await db.selectDistinct({ id: properties.investorId }).from(properties).where(inArray(properties.id, pids));
  return rows.map((r) => r.id);
}

export async function assertInvestorAccess(db: DB, user: SessionUser, investorId: string) {
  if (!(await allowedInvestorIds(db, user)).includes(investorId)) throw notFound("Không tìm thấy nhà đầu tư");
}

export { and, eq };

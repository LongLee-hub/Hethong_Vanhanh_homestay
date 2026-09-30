// Quản trị kết nối Dayladau cho từng nhà đầu tư: lưu host ID + access token, kiểm tra kết nối,
// gắn listing Dayladau với phòng. Chỉ Admin. Token lưu mã hóa AES-256-GCM, không bao giờ trả ra ngoài.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { alerts, investors, properties, rooms } from "../db/schema";
import { badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { decryptSecret, encryptSecret } from "../services/settings";
import { fetchOrdersPage, PAGE_SIZE } from "./client";
import { mapDayladauOrder } from "./mapping";

const HOST_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const TOKEN_RE = /^[A-Za-z0-9._~-]{16,512}$/;

export interface InvestorConnection {
  id: string;
  name: string;
  hostId: string | null;
  hasToken: boolean;
  tokenHint: string | null; // 4 ký tự cuối
}

function hint(enc: string | null, decrypt: (s: string) => string): string | null {
  if (!enc) return null;
  try {
    return "…" + decrypt(enc).slice(-4);
  } catch {
    return "(không giải mã được — nhập lại token)";
  }
}

export async function listConnections(db: DB, user: SessionUser, decrypt = decryptSecret): Promise<InvestorConnection[]> {
  requirePermission(user, "admin");
  const rows = await db.select().from(investors).orderBy(investors.name);
  return rows.map((i) => ({ id: i.id, name: i.name, hostId: i.dayladauHostId, hasToken: !!i.dayladauTokenEncrypted, tokenHint: hint(i.dayladauTokenEncrypted, decrypt) }));
}

/** Tạo NĐT mới hoặc cập nhật thông tin kết nối. Token để trống khi sửa = giữ token cũ. */
export async function saveInvestorConnection(
  db: DB,
  user: SessionUser,
  input: { id?: string; name: string; hostId: string; token?: string },
  encrypt = encryptSecret,
): Promise<InvestorConnection> {
  requirePermission(user, "admin");
  const name = input.name?.trim();
  const hostId = input.hostId?.trim();
  const token = input.token?.trim();
  if (!name) throw badRequest("Nhập tên nhà đầu tư");
  if (!hostId || !HOST_ID_RE.test(hostId)) throw badRequest("Host ID không hợp lệ (chỉ gồm chữ, số, - và _)");
  if (token && !TOKEN_RE.test(token)) throw badRequest("Access token không hợp lệ (có khoảng trắng hoặc ký tự lạ?)");

  const dup = await db.select({ id: investors.id }).from(investors).where(eq(investors.dayladauHostId, hostId));
  if (dup.some((d) => d.id !== input.id)) throw badRequest("Host ID này đã gắn với nhà đầu tư khác");

  if (input.id) {
    const [prev] = await db.select().from(investors).where(eq(investors.id, input.id)).limit(1);
    if (!prev) throw notFound("Không tìm thấy nhà đầu tư");
    const patch: Partial<typeof investors.$inferInsert> = { name, dayladauHostId: hostId };
    if (token) patch.dayladauTokenEncrypted = encrypt(token);
    await db.update(investors).set(patch).where(eq(investors.id, input.id));
    return { id: input.id, name, hostId, hasToken: !!(token || prev.dayladauTokenEncrypted), tokenHint: token ? "…" + token.slice(-4) : null };
  }
  if (!token) throw badRequest("Nhập access token Dayladau");
  const [row] = await db.insert(investors).values({ name, dayladauHostId: hostId, dayladauTokenEncrypted: encrypt(token) }).returning();
  return { id: row.id, name, hostId, hasToken: true, tokenHint: "…" + token.slice(-4) };
}

export interface ListingSummary {
  key: string;
  name: string;
  orders: number;
  roomId: string | null;
}

export interface ConnectionTest {
  ok: boolean;
  error?: string;
  ordersOnFirstPage: number;
  listings: ListingSummary[];
  statuses: { status: string; orders: number; treatedAs: "CONFIRMED" | "CANCELLED" }[];
  /** Vài đơn mẫu (không có tên/SĐT khách) để đối chiếu tiền host với Dayladau */
  samples: { id: string; listing: string; checkIn: string; checkOut: string; totalBilled: number; hostAmount: number; rentalType: string | null }[];
}

/** Gọi trang đầu (100 đơn) để kiểm tra host ID + token và liệt kê listing cần gắn phòng. */
export async function testConnection(
  db: DB,
  user: SessionUser,
  investorId: string,
  deps: { fetchPage?: typeof fetchOrdersPage; decrypt?: (s: string) => string } = {},
): Promise<ConnectionTest> {
  requirePermission(user, "admin");
  const [inv] = await db.select().from(investors).where(eq(investors.id, investorId)).limit(1);
  if (!inv) throw notFound("Không tìm thấy nhà đầu tư");
  if (!inv.dayladauHostId || !inv.dayladauTokenEncrypted) throw badRequest("Nhà đầu tư chưa có host ID hoặc access token");
  const fetchPage = deps.fetchPage ?? fetchOrdersPage;
  const decrypt = deps.decrypt ?? decryptSecret;
  let orders;
  try {
    orders = await fetchPage(inv.dayladauHostId, decrypt(inv.dayladauTokenEncrypted), 0, PAGE_SIZE);
  } catch (e) {
    return { ok: false, error: (e as Error).message, ordersOnFirstPage: 0, listings: [], statuses: [], samples: [] };
  }
  const props = await db.select({ id: properties.id }).from(properties).where(eq(properties.investorId, investorId));
  const invRooms = props.length ? await db.select().from(rooms).where(inArray(rooms.propertyId, props.map((p) => p.id))) : [];
  const listings = new Map<string, ListingSummary>();
  const statuses = new Map<string, { orders: number; treatedAs: "CONFIRMED" | "CANCELLED" }>();
  const samples: ConnectionTest["samples"] = [];
  for (const o of orders) {
    let m;
    try {
      m = mapDayladauOrder(o);
    } catch {
      continue;
    }
    const l = listings.get(m.listingKey) ?? { key: m.listingKey, name: m.listingName, orders: 0, roomId: invRooms.find((r) => r.dayladauRoomId === m.listingKey || r.dayladauRoomId === m.listingName)?.id ?? null };
    l.orders++;
    listings.set(m.listingKey, l);
    const s = statuses.get(m.rawStatus) ?? { orders: 0, treatedAs: m.status };
    s.orders++;
    statuses.set(m.rawStatus, s);
    if (samples.length < 5 && m.status === "CONFIRMED") {
      samples.push({ id: m.externalId, listing: m.listingName, checkIn: m.checkIn, checkOut: m.checkOut, totalBilled: m.grossAmount, hostAmount: m.hostAmount, rentalType: m.rentalType });
    }
  }
  return {
    ok: true,
    ordersOnFirstPage: orders.length,
    listings: [...listings.values()].sort((a, b) => a.name.localeCompare(b.name, "vi")),
    statuses: [...statuses.entries()].map(([status, v]) => ({ status, ...v })),
    samples,
  };
}

/** Gắn một listing Dayladau với phòng (hoặc bỏ gắn khi roomId rỗng). */
export async function mapListingToRoom(db: DB, user: SessionUser, investorId: string, listingKey: string, roomId: string | null) {
  requirePermission(user, "admin");
  if (!listingKey) throw badRequest("Thiếu mã listing");
  const props = await db.select({ id: properties.id }).from(properties).where(eq(properties.investorId, investorId));
  const pids = props.map((p) => p.id);
  // Bỏ gắn listing này khỏi phòng cũ (nếu có)
  if (pids.length) await db.update(rooms).set({ dayladauRoomId: null }).where(and(eq(rooms.dayladauRoomId, listingKey), inArray(rooms.propertyId, pids)));
  if (!roomId) return;
  const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  if (!room || !pids.includes(room.propertyId)) throw badRequest("Phòng không thuộc cơ sở của nhà đầu tư này");
  const [taken] = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.dayladauRoomId, listingKey)).limit(1);
  if (taken && taken.id !== roomId) throw badRequest("Listing này đã gắn với phòng của nhà đầu tư khác");
  await db.update(rooms).set({ dayladauRoomId: listingKey }).where(eq(rooms.id, roomId));
  // Cảnh báo "listing chưa gắn phòng" của listing này hết hiệu lực
  await db.update(alerts).set({ resolvedAt: new Date() }).where(and(eq(alerts.key, `UNMAPPED_ROOM:${investorId}:${listingKey}`), isNull(alerts.resolvedAt)));
}

/** Tạo cơ sở / phòng nhanh từ màn hình gắn listing. */
export async function createProperty(db: DB, user: SessionUser, input: { investorId: string; name: string; investmentAmount?: number; investmentStartMonth?: string }) {
  requirePermission(user, "admin");
  if (!input.name?.trim()) throw badRequest("Nhập tên cơ sở");
  const [row] = await db
    .insert(properties)
    .values({ investorId: input.investorId, name: input.name.trim(), investmentAmount: input.investmentAmount ?? 0, investmentStartMonth: input.investmentStartMonth || null })
    .returning();
  return row;
}

export async function createRoom(db: DB, user: SessionUser, input: { propertyId: string; name: string; openedOn: string; listingKey?: string }) {
  requirePermission(user, "admin");
  if (!input.name?.trim()) throw badRequest("Nhập tên phòng");
  if (!input.propertyId) throw badRequest("Chọn cơ sở cho phòng mới");
  const [prop] = await db.select({ investorId: properties.investorId }).from(properties).where(eq(properties.id, input.propertyId)).limit(1);
  if (!prop) throw badRequest("Không tìm thấy cơ sở — tải lại trang rồi thử lại");
  // Tạo phòng rồi gắn listing trong cùng giao dịch: listing đang gắn phòng cũ sẽ chuyển sang phòng mới,
  // gắn lỗi (vd listing thuộc nhà đầu tư khác) thì không để lại phòng mồ côi.
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(rooms).values({ propertyId: input.propertyId, name: input.name.trim(), openedOn: input.openedOn }).returning();
    if (input.listingKey) {
      await mapListingToRoom(tx as unknown as DB, user, prop.investorId, input.listingKey, row.id);
      row.dayladauRoomId = input.listingKey;
    }
    return row;
  });
}


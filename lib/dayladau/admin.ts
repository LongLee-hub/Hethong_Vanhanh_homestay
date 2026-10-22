// Quản trị nhà đầu tư và tài khoản Dayladau: thông tin NĐT, host ID + access token của từng tài khoản,
// cơ sở dùng tài khoản nào, kiểm tra kết nối, gắn listing Dayladau với phòng. Chỉ Admin.
// Token lưu mã hóa AES-256-GCM, không bao giờ trả ra ngoài.
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DB } from "../db";
import { alerts, dayladauAccounts, investors, properties, rooms } from "../db/schema";
import { badRequest, notFound, requirePermission, type SessionUser } from "../auth/access";
import { decryptSecret, encryptSecret } from "../services/settings";
import { fetchOrdersPage, PAGE_SIZE } from "./client";
import { mapDayladauOrder } from "./mapping";
import { DISMISSIBLE_ALERTS } from "./alert-types";
import { isLarkWebhook } from "../services/expense-notify";
import { attachListing, clearRoomListings, detachListing, listingRef, roomsByListing } from "./room-listings";

const HOST_ID_RE = /^[A-Za-z0-9_-]{3,64}$/;
const TOKEN_RE = /^[A-Za-z0-9._~-]{16,512}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type AccountRow = typeof dayladauAccounts.$inferSelect;

export interface AccountConnection {
  id: string;
  investorId: string;
  label: string;
  hostId: string;
  hasToken: boolean;
  tokenHint: string | null; // 4 ký tự cuối
  active: boolean;
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  propertyIds: string[]; // cơ sở lấy đơn từ tài khoản này
}

export interface InvestorInfo {
  name: string;
  phone: string | null;
  email: string | null;
  taxCode: string | null;
  address: string | null;
  bankName: string | null;
  bankAccountNo: string | null;
  bankAccountName: string | null;
  managementFeePct: number | null; // null = dùng mức chung
  /** CĐT đặc biệt: thuế GTGT % doanh thu, thuế TNCN % lợi nhuận sau phí. null = không áp dụng. Không truyền = giữ nguyên. */
  vatPct?: number | null;
  pitPct?: number | null;
  contractStartOn: string | null;
  contractEndOn: string | null;
  contractUrl: string | null;
  payoutDay: number | null;
  active: boolean;
  note: string | null;
  /** Webhook bot Lark của nhóm chat có chủ nhà (nhắc duyệt chi phí). */
  larkWebhookUrl?: string | null;
}

export interface InvestorConnection extends InvestorInfo {
  id: string;
  hasAccount: boolean; // đã có tài khoản đăng nhập
  accounts: AccountConnection[];
}

function hint(a: AccountRow, decrypt: (s: string) => string): string | null {
  if (a.tokenLast4) return "…" + a.tokenLast4;
  try {
    return "…" + decrypt(a.tokenEncrypted).slice(-4);
  } catch {
    return "(không giải mã được — nhập lại token)";
  }
}

export async function listConnections(db: DB, user: SessionUser, decrypt = decryptSecret): Promise<InvestorConnection[]> {
  requirePermission(user, "admin");
  const [invs, accs, props] = await Promise.all([
    db.select().from(investors).orderBy(investors.name),
    db.select().from(dayladauAccounts).orderBy(dayladauAccounts.label),
    db.select({ id: properties.id, accountId: properties.dayladauAccountId }).from(properties),
  ]);
  return invs.map((i) => ({
    id: i.id, name: i.name, phone: i.phone, email: i.email, taxCode: i.taxCode, address: i.address,
    bankName: i.bankName, bankAccountNo: i.bankAccountNo, bankAccountName: i.bankAccountName,
    managementFeePct: i.managementFeePct, vatPct: i.vatPct, pitPct: i.pitPct, contractStartOn: i.contractStartOn, contractEndOn: i.contractEndOn,
    contractUrl: i.contractUrl, payoutDay: i.payoutDay, active: i.active, note: i.note, larkWebhookUrl: i.larkWebhookUrl, hasAccount: !!i.userId,
    accounts: accs
      .filter((a) => a.investorId === i.id)
      .map((a) => ({
        id: a.id, investorId: a.investorId, label: a.label, hostId: a.hostId, hasToken: !!a.tokenEncrypted, tokenHint: hint(a, decrypt),
        active: a.active, lastSyncedAt: a.lastSyncedAt, lastSyncStatus: a.lastSyncStatus, lastSyncError: a.lastSyncError,
        propertyIds: props.filter((p) => p.accountId === a.id).map((p) => p.id),
      })),
  }));
}

/** Tạo NĐT mới hoặc sửa thông tin NĐT. */
export async function saveInvestor(db: DB, user: SessionUser, input: { id?: string } & InvestorInfo) {
  requirePermission(user, "admin");
  const name = input.name?.trim();
  if (!name) throw badRequest("Nhập tên nhà đầu tư");
  const fee = input.managementFeePct;
  if (fee != null && (!Number.isFinite(fee) || fee < 0 || fee > 100)) throw badRequest("Phí quản lý phải từ 0 đến 100%");
  for (const [v, label] of [[input.vatPct, "Thuế GTGT"], [input.pitPct, "Thuế TNCN"]] as const) {
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 100)) throw badRequest(`${label} phải từ 0 đến 100%`);
  }
  if (input.payoutDay != null && (!Number.isInteger(input.payoutDay) || input.payoutDay < 1 || input.payoutDay > 28)) throw badRequest("Ngày chuyển tiền phải từ 1 đến 28");
  for (const d of [input.contractStartOn, input.contractEndOn]) if (d && !DATE_RE.test(d)) throw badRequest("Ngày hợp đồng không hợp lệ");
  if (input.contractStartOn && input.contractEndOn && input.contractEndOn < input.contractStartOn) throw badRequest("Ngày kết thúc hợp đồng phải sau ngày bắt đầu");
  if (input.email && !/^[^\s@]+@[^\s@]+$/.test(input.email)) throw badRequest("Email không hợp lệ");
  if (input.larkWebhookUrl?.trim() && !isLarkWebhook(input.larkWebhookUrl.trim())) {
    throw badRequest("Webhook Lark không hợp lệ: dán địa chỉ dạng https://open.larksuite.com/open-apis/bot/v2/hook/…");
  }
  const t = (v: string | null) => v?.trim() || null;
  const values = {
    name, phone: t(input.phone), email: t(input.email), taxCode: t(input.taxCode), address: t(input.address),
    bankName: t(input.bankName), bankAccountNo: t(input.bankAccountNo), bankAccountName: t(input.bankAccountName),
    managementFeePct: fee, contractStartOn: input.contractStartOn || null, contractEndOn: input.contractEndOn || null,
    contractUrl: t(input.contractUrl), payoutDay: input.payoutDay, active: input.active, note: t(input.note),
    // 0% coi như không áp dụng
    ...(input.vatPct !== undefined ? { vatPct: input.vatPct || null } : {}),
    ...(input.pitPct !== undefined ? { pitPct: input.pitPct || null } : {}),
    // Không truyền (form cũ / test) thì giữ nguyên webhook đang lưu
    ...(input.larkWebhookUrl !== undefined ? { larkWebhookUrl: t(input.larkWebhookUrl) } : {}),
  };
  if (input.id) {
    const [row] = await db.update(investors).set(values).where(eq(investors.id, input.id)).returning();
    if (!row) throw notFound("Không tìm thấy nhà đầu tư");
    return row;
  }
  const [row] = await db.insert(investors).values(values).returning();
  return row;
}

/**
 * Tạo hoặc sửa tài khoản Dayladau của NĐT. Token để trống khi sửa = giữ token cũ.
 * propertyIds (nếu truyền): đúng danh sách cơ sở dùng tài khoản này; cơ sở bỏ chọn sẽ không còn tài khoản.
 */
export async function saveDayladauAccount(
  db: DB,
  user: SessionUser,
  input: { id?: string; investorId: string; label: string; hostId: string; token?: string; active?: boolean; propertyIds?: string[] },
  encrypt = encryptSecret,
): Promise<Omit<AccountRow, "tokenEncrypted">> {
  requirePermission(user, "admin");
  const label = input.label?.trim();
  const hostId = input.hostId?.trim();
  const token = input.token?.trim();
  if (!label) throw badRequest("Đặt tên cho tài khoản, vd: TK Hội An");
  if (!hostId || !HOST_ID_RE.test(hostId)) throw badRequest("Host ID không hợp lệ (chỉ gồm chữ, số, - và _)");
  if (token && !TOKEN_RE.test(token)) throw badRequest("Access token không hợp lệ (có khoảng trắng hoặc ký tự lạ?)");

  const dup = await db.select({ id: dayladauAccounts.id }).from(dayladauAccounts).where(eq(dayladauAccounts.hostId, hostId));
  if (dup.some((d) => d.id !== input.id)) throw badRequest("Host ID này đã có tài khoản khác dùng");

  const tokenPatch = token ? { tokenEncrypted: encrypt(token), tokenLast4: token.slice(-4), tokenUpdatedAt: new Date() } : {};
  const saved = await db.transaction(async (tx) => {
    let row: AccountRow;
    if (input.id) {
      const [prev] = await tx.select().from(dayladauAccounts).where(eq(dayladauAccounts.id, input.id)).limit(1);
      if (!prev) throw notFound("Không tìm thấy tài khoản Dayladau");
      // Đổi host ID là sang tài khoản khác: mã listing cũ không còn đúng
      if (prev.hostId !== hostId) await clearRoomListings(tx as unknown as DB, { accountId: prev.id });
      [row] = await tx
        .update(dayladauAccounts)
        .set({ label, hostId, active: input.active ?? prev.active, ...tokenPatch })
        .where(eq(dayladauAccounts.id, input.id))
        .returning();
    } else {
      if (!token) throw badRequest("Nhập access token Dayladau");
      const [inv] = await tx.select({ id: investors.id }).from(investors).where(eq(investors.id, input.investorId)).limit(1);
      if (!inv) throw notFound("Không tìm thấy nhà đầu tư");
      [row] = await tx.insert(dayladauAccounts).values({ investorId: input.investorId, label, hostId, active: input.active ?? true, ...tokenPatch } as typeof dayladauAccounts.$inferInsert).returning();
    }
    if (input.propertyIds) {
      const want = new Set(input.propertyIds);
      const props = await tx.select().from(properties).where(eq(properties.investorId, row.investorId));
      if ([...want].some((id) => !props.some((p) => p.id === id))) throw badRequest("Cơ sở không thuộc nhà đầu tư này");
      for (const p of props) {
        if (want.has(p.id) && p.dayladauAccountId !== row.id) await assignAccount(tx as unknown as DB, p.id, row.id);
        if (!want.has(p.id) && p.dayladauAccountId === row.id) await assignAccount(tx as unknown as DB, p.id, null);
      }
    }
    return row;
  });
  const { tokenEncrypted: _, ...safe } = saved;
  return safe;
}

/** Đổi tài khoản Dayladau của cơ sở; listing đã gắn ở các phòng thuộc tài khoản cũ nên được bỏ gắn. */
async function assignAccount(db: DB, propertyId: string, accountId: string | null) {
  await db.update(properties).set({ dayladauAccountId: accountId }).where(eq(properties.id, propertyId));
  const rs = await db.select({ id: rooms.id }).from(rooms).where(eq(rooms.propertyId, propertyId));
  await clearRoomListings(db, { roomIds: rs.map((r) => r.id) });
}

/** Chọn tài khoản Dayladau cho một cơ sở (null = chỉ nhập đơn tay). Tài khoản phải cùng NĐT với cơ sở. */
export async function setPropertyAccount(db: DB, user: SessionUser, propertyId: string, accountId: string | null) {
  requirePermission(user, "admin");
  const [prop] = await db.select().from(properties).where(eq(properties.id, propertyId)).limit(1);
  if (!prop) throw notFound("Không tìm thấy cơ sở");
  if (prop.dayladauAccountId === accountId) return;
  if (accountId) {
    const [acc] = await db.select({ investorId: dayladauAccounts.investorId }).from(dayladauAccounts).where(eq(dayladauAccounts.id, accountId)).limit(1);
    if (!acc) throw notFound("Không tìm thấy tài khoản Dayladau");
    if (acc.investorId !== prop.investorId) throw badRequest("Tài khoản Dayladau thuộc nhà đầu tư khác");
  }
  await db.transaction((tx) => assignAccount(tx as unknown as DB, propertyId, accountId));
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
  accountId: string,
  deps: { fetchPage?: typeof fetchOrdersPage; decrypt?: (s: string) => string } = {},
): Promise<ConnectionTest> {
  requirePermission(user, "admin");
  const [acc] = await db.select().from(dayladauAccounts).where(eq(dayladauAccounts.id, accountId)).limit(1);
  if (!acc) throw notFound("Không tìm thấy tài khoản Dayladau");
  const fetchPage = deps.fetchPage ?? fetchOrdersPage;
  const decrypt = deps.decrypt ?? decryptSecret;
  let orders;
  try {
    orders = await fetchPage(acc.hostId, decrypt(acc.tokenEncrypted), 0, PAGE_SIZE);
  } catch (e) {
    return { ok: false, error: (e as Error).message, ordersOnFirstPage: 0, listings: [], statuses: [], samples: [] };
  }
  const byListing = await roomsByListing(db, [accountId]);
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
    const l = listings.get(m.listingKey) ?? { key: m.listingKey, name: m.listingName, orders: 0, roomId: (byListing.get(listingRef(accountId, m.listingKey)) ?? byListing.get(listingRef(accountId, m.listingName)))?.id ?? null };
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

/**
 * Gắn một listing của tài khoản với phòng (hoặc bỏ gắn khi roomId rỗng). Phòng phải thuộc cơ sở dùng tài khoản này.
 * Phòng đã có listing thì listing mới được gắn thêm (listing phụ), không thay listing cũ.
 */
export async function mapListingToRoom(db: DB, user: SessionUser, accountId: string, listingKey: string, roomId: string | null) {
  requirePermission(user, "admin");
  if (!listingKey) throw badRequest("Thiếu mã listing");
  if (!roomId) return detachListing(db, accountId, listingKey);
  const [row] = await db
    .select({ accountId: properties.dayladauAccountId })
    .from(rooms)
    .innerJoin(properties, eq(properties.id, rooms.propertyId))
    .where(eq(rooms.id, roomId))
    .limit(1);
  if (!row || row.accountId !== accountId) throw badRequest("Phòng không thuộc cơ sở dùng tài khoản Dayladau này");
  await attachListing(db, accountId, listingKey, roomId);
  // Cảnh báo "listing chưa gắn phòng" của listing này hết hiệu lực
  await db.update(alerts).set({ resolvedAt: new Date() }).where(and(eq(alerts.key, `UNMAPPED_ROOM:${accountId}:${listingKey}`), isNull(alerts.resolvedAt)));
}

/** Tạo cơ sở / phòng nhanh từ màn hình gắn listing. */
export async function createProperty(
  db: DB,
  user: SessionUser,
  input: { investorId: string; name: string; investmentAmount?: number; investmentStartMonth?: string; dayladauAccountId?: string | null },
) {
  requirePermission(user, "admin");
  if (!input.name?.trim()) throw badRequest("Nhập tên cơ sở");
  if (input.dayladauAccountId) {
    const [acc] = await db.select({ investorId: dayladauAccounts.investorId }).from(dayladauAccounts).where(eq(dayladauAccounts.id, input.dayladauAccountId)).limit(1);
    if (!acc || acc.investorId !== input.investorId) throw badRequest("Tài khoản Dayladau không thuộc nhà đầu tư này");
  }
  const [row] = await db
    .insert(properties)
    .values({
      investorId: input.investorId, name: input.name.trim(), investmentAmount: input.investmentAmount ?? 0,
      investmentStartMonth: input.investmentStartMonth || null, dayladauAccountId: input.dayladauAccountId || null,
    })
    .returning();
  return row;
}

export async function createRoom(db: DB, user: SessionUser, input: { propertyId: string; name: string; openedOn: string; listingKey?: string }) {
  requirePermission(user, "admin");
  if (!input.name?.trim()) throw badRequest("Nhập tên phòng");
  if (!input.propertyId) throw badRequest("Chọn cơ sở cho phòng mới");
  const [prop] = await db.select({ accountId: properties.dayladauAccountId }).from(properties).where(eq(properties.id, input.propertyId)).limit(1);
  if (!prop) throw badRequest("Không tìm thấy cơ sở — tải lại trang rồi thử lại");
  if (input.listingKey && !prop.accountId) throw badRequest("Cơ sở chưa chọn tài khoản Dayladau, chưa gắn được listing");
  // Tạo phòng rồi gắn listing trong cùng giao dịch: listing đang gắn phòng cũ sẽ chuyển sang phòng mới,
  // gắn lỗi thì không để lại phòng mồ côi.
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(rooms).values({ propertyId: input.propertyId, name: input.name.trim(), openedOn: input.openedOn }).returning();
    if (input.listingKey) {
      await mapListingToRoom(tx as unknown as DB, user, prop.accountId!, input.listingKey, row.id);
      row.dayladauAccountId = prop.accountId;
      row.dayladauRoomId = input.listingKey;
    }
    return row;
  });
}

/** Danh sách listing cho cơ sở: dùng tài khoản Dayladau của cơ sở đó. */
export async function listingsForProperty(db: DB, user: SessionUser, propertyId: string, deps?: Parameters<typeof testConnection>[3]): Promise<ConnectionTest> {
  requirePermission(user, "admin");
  const [prop] = await db.select({ accountId: properties.dayladauAccountId }).from(properties).where(eq(properties.id, propertyId)).limit(1);
  if (!prop) throw notFound("Không tìm thấy cơ sở");
  if (!prop.accountId) throw badRequest("Cơ sở chưa chọn tài khoản Dayladau");
  return testConnection(db, user, prop.accountId, deps);
}

export async function dismissSyncAlert(db: DB, user: SessionUser, alertId: string) {
  requirePermission(user, "admin");
  const [a] = await db.select({ type: alerts.type }).from(alerts).where(and(eq(alerts.id, alertId), isNull(alerts.resolvedAt))).limit(1);
  if (!a) throw notFound("Cảnh báo không còn mở");
  if (!DISMISSIBLE_ALERTS.includes(a.type)) throw badRequest("Cảnh báo này tự đóng khi đã gắn listing với phòng");
  await db.update(alerts).set({ resolvedAt: new Date() }).where(eq(alerts.id, alertId));
}

/** Các tài khoản Dayladau theo NĐT, cho ô chọn ở màn hình cơ sở. */
export async function accountsByInvestor(db: DB, investorIds: string[]) {
  if (!investorIds.length) return [];
  return db
    .select({ id: dayladauAccounts.id, investorId: dayladauAccounts.investorId, label: dayladauAccounts.label, hostId: dayladauAccounts.hostId })
    .from(dayladauAccounts)
    .where(inArray(dayladauAccounts.investorId, investorIds))
    .orderBy(dayladauAccounts.label);
}

// Phiếu thanh toán Dayladau: Dayladau thu tiền khách đặt trên Dayladau (app, web, CTV…) rồi chuyển cho host theo phiếu,
// thường mỗi tuần một phiếu. Đồng bộ phiếu và từng đơn trong phiếu, đối chiếu tiền từng đơn với đơn trong hệ thống.
//
// API (giống trang host.dayladau.com/report → Lịch sử thanh toán, kiểm chứng tháng 10/2026: tổng tiền các đơn = tiền phiếu):
//   GET /v1/payouts?host_id=&start_time=&end_time=&limit=   (thời gian là epoch mili-giây)
//     → [{ id, order_ids: "309739,309695,…", amount, status, created_at, confirmed_at, picture_url, transfer_ref, note }]
//   GET /v1/orders?host_id=&version=2&payout_status=paid|unpaid&offset=&limit=100
//     → { orders: [...], total }. Mỗi đơn có payout_id, payout_at, payout_amount; items[].host_amount.
// Trang chi tiết phiếu trên web Dayladau đang lỗi (hiện "Vô danh"), nên tiền từng đơn lấy từ /v1/orders.
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { bookings, dayladauAccounts, dayladauPayoutItems, dayladauPayouts, investors } from "../db/schema";
import { allowedInvestorIds, badRequest, type SessionUser } from "../auth/access";
import { decryptSecret } from "../services/settings";
import { DAYLADAU_BASE, PAGE_SIZE, redact, withRetry } from "./client";
import { hostAmountOf, toVNDate, type RawOrder } from "./mapping";
import { refreshBookingsFromOrders } from "./order-refresh";

export type RawPayout = Record<string, any>;

/** Lệch dưới mức này (VND, làm tròn) coi là khớp. */
export const DL_PAYOUT_TOLERANCE = 1;
/** Đồng bộ thường kỳ lấy phiếu của chừng này ngày gần nhất. */
export const DL_PAYOUT_DAYS = 45;
/** Trần số đơn đã thanh toán đọc mỗi tài khoản khi tìm đơn của phiếu (API trả đơn mới trước). */
export const DL_MAX_PAID_ORDERS = 15_000;
export const DL_MAX_UNPAID_ORDERS = 3_000;

export interface DayladauPayoutApi {
  listPayouts(hostId: string, token: string, fromMs: number, toMs: number): Promise<RawPayout[]>;
  /** Một trang đơn theo trạng thái thanh toán. */
  listOrders(hostId: string, token: string, status: "paid" | "unpaid", offset: number): Promise<RawOrder[]>;
}

async function getJson(url: string, token: string, what: string): Promise<unknown> {
  return withRetry(async () => {
    let r: Response;
    try {
      r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(redact(`Không kết nối được Dayladau (${what}): ${(e as Error).message}`, token));
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Host ID hoặc access token không hợp lệ (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`Dayladau trả lỗi HTTP ${r.status} khi lấy ${what}`);
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("json")) throw new Error(`Dayladau không trả JSON khi lấy ${what} (có thể sai đường dẫn API)`);
    return r.json();
  });
}

export function payoutsUrl(hostId: string, token: string, fromMs: number, toMs: number, offset = 0): string {
  const u = new URL(`${DAYLADAU_BASE}/v1/payouts`);
  u.searchParams.set("host_id", hostId);
  u.searchParams.set("start_time", String(fromMs));
  u.searchParams.set("end_time", String(toMs));
  u.searchParams.set("limit", String(PAGE_SIZE));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("x_access_token", token);
  return u.toString();
}

export function payoutOrdersUrl(hostId: string, token: string, status: "paid" | "unpaid", offset: number): string {
  const u = new URL(`${DAYLADAU_BASE}/v1/orders`);
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("limit", String(PAGE_SIZE));
  u.searchParams.set("host_id", hostId);
  u.searchParams.set("version", "2");
  u.searchParams.set("payout_status", status);
  u.searchParams.set("x_access_token", token);
  return u.toString();
}

export const httpPayoutApi: DayladauPayoutApi = {
  async listPayouts(hostId, token, fromMs, toMs) {
    const byId = new Map<string, RawPayout>();
    for (let offset = 0; offset < 2000; offset += PAGE_SIZE) {
      const data = await getJson(payoutsUrl(hostId, token, fromMs, toMs, offset), token, "phiếu thanh toán");
      const page = (Array.isArray(data) ? data : (data as { payouts?: unknown })?.payouts) as RawPayout[] | undefined;
      if (!Array.isArray(page)) throw new Error("Phản hồi Dayladau không có danh sách phiếu thanh toán");
      const before = byId.size;
      for (const p of page) if (p?.id !== undefined && p?.id !== null) byId.set(String(p.id), p);
      // Dừng khi hết trang, hoặc trang không thêm phiếu mới (API bỏ qua offset)
      if (page.length < PAGE_SIZE || byId.size === before) break;
    }
    return [...byId.values()];
  },
  async listOrders(hostId, token, status, offset) {
    const data = (await getJson(payoutOrdersUrl(hostId, token, status, offset), token, "đơn")) as { orders?: RawOrder[] };
    if (!Array.isArray(data?.orders)) throw new Error("Phản hồi Dayladau không có danh sách orders");
    return data.orders;
  },
};

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Tiền Dayladau trả host cho một đơn: payout_amount; chưa có (đơn chờ trả) thì Σ items.host_amount, cuối cùng mới tự tính. */
export function payoutAmountOf(o: RawOrder): number {
  if (o?.payout_amount !== undefined && o?.payout_amount !== null && num(o.payout_amount) !== 0) return Math.round(num(o.payout_amount));
  if (Array.isArray(o?.items) && o.items.some((it: any) => it?.host_amount !== undefined)) {
    return Math.round(o.items.reduce((s: number, it: any) => s + num(it?.host_amount), 0));
  }
  return hostAmountOf(o);
}

export interface PayoutOrderLine {
  orderId: string;
  listingKey: string | null;
  listingName: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  orderStatus: string | null;
  source: string | null;
  grossAmount: number;
  amount: number;
}

export function mapPayoutOrder(o: RawOrder): PayoutOrderLine {
  const listingId = o?.listing?.id ?? o?.listing_id;
  const nickname = String(o?.listing?.nickname ?? "").trim();
  const name = String(o?.listing?.name ?? "").trim();
  return {
    orderId: String(o?.id ?? "").trim(),
    listingKey: listingId !== undefined && listingId !== null && listingId !== "" ? String(listingId) : name || null,
    listingName: nickname || name || null,
    guestName: o?.guest?.fullname ? String(o.guest.fullname).trim() : null,
    checkIn: toVNDate(o?.reservation?.start_time),
    checkOut: toVNDate(o?.reservation?.end_time),
    orderStatus: o?.reservation?.status ? String(o.reservation.status) : o?.status ? String(o.status) : null,
    source: o?.reservation?.source ? String(o.reservation.source) : null,
    grossAmount: Math.round(num(o?.total_billed ?? o?.total)),
    amount: payoutAmountOf(o),
  };
}

export type MatchStatus = "MATCHED" | "AMOUNT_DIFF" | "NOT_FOUND";

/** So tiền Dayladau trả cho đơn với thực nhận đang ghi trong hệ thống. */
export function matchLine(amount: number, booking: { netAmount: number } | undefined): { status: MatchStatus; diff: number | null } {
  if (!booking) return { status: "NOT_FOUND", diff: null };
  const diff = amount - booking.netAmount;
  return { status: Math.abs(diff) <= DL_PAYOUT_TOLERANCE ? "MATCHED" : "AMOUNT_DIFF", diff };
}

/** Mili-giây của 00:00 giờ VN ngày d. */
const vnStartMs = (d: string) => Date.parse(`${d}T00:00:00+07:00`);

export interface DlPayoutSyncSummary {
  accounts: number;
  payouts: number;
  orders: number;
  matched: number;
  amountDiff: number;
  notFound: number;
  /** Phiếu có tổng tiền các đơn khác tiền phiếu (thiếu đơn hoặc Dayladau cộng sai). */
  totalMismatch: number;
  pending: number;
  /** Đơn trong hệ thống được cập nhật / tạo mới theo bản mới nhất của đơn trong phiếu (gia hạn, giảm giá, đơn bị sót). */
  bookingsUpdated: number;
  bookingsCreated: number;
  errors: { accountId: string; investorId: string; message: string }[];
}

export async function syncDayladauPayouts(
  db: DB,
  opts: { api?: DayladauPayoutApi; decrypt?: (s: string) => string; from?: string; to?: string; accountIds?: string[]; investorIds?: string[]; today?: string } = {},
): Promise<DlPayoutSyncSummary> {
  const api = opts.api ?? httpPayoutApi;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const from = opts.from ?? D.addDays(today, -DL_PAYOUT_DAYS);
  const to = opts.to ?? today;
  const sum: DlPayoutSyncSummary = { accounts: 0, payouts: 0, orders: 0, matched: 0, amountDiff: 0, notFound: 0, totalMismatch: 0, pending: 0, bookingsUpdated: 0, bookingsCreated: 0, errors: [] };

  const conds = [eq(dayladauAccounts.active, true)];
  if (opts.accountIds?.length) conds.push(inArray(dayladauAccounts.id, opts.accountIds));
  if (opts.investorIds?.length) conds.push(inArray(dayladauAccounts.investorId, opts.investorIds));
  const accs = await db.select().from(dayladauAccounts).where(and(...conds));

  for (const acc of accs) {
    sum.accounts++;
    try {
      const token = decrypt(acc.tokenEncrypted);
      const raws = await api.listPayouts(acc.hostId, token, vnStartMs(from), vnStartMs(D.addDays(to, 1)) - 1);
      const payouts = raws.filter((p) => p?.id !== undefined && p?.id !== null);
      const idsOf = (p: RawPayout) => String(p.order_ids ?? "").split(",").map((s) => s.trim()).filter(Boolean);

      // Tìm đơn của các phiếu trong danh sách đơn đã thanh toán (mới trước), dừng khi đủ
      const need = new Set(payouts.flatMap(idsOf));
      const orders = new Map<string, RawOrder>();
      for (let offset = 0; need.size && offset < DL_MAX_PAID_ORDERS; offset += PAGE_SIZE) {
        const page = await api.listOrders(acc.hostId, token, "paid", offset);
        for (const o of page) {
          const k = String(o?.id ?? "");
          if (need.delete(k)) orders.set(k, o);
        }
        if (page.length < PAGE_SIZE) break;
      }

      // Đơn đang chờ Dayladau trả
      const unpaid: RawOrder[] = [];
      for (let offset = 0; offset < DL_MAX_UNPAID_ORDERS; offset += PAGE_SIZE) {
        const page = await api.listOrders(acc.hostId, token, "unpaid", offset);
        unpaid.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      // Đơn đặt từ lâu rồi mới sửa trên Dayladau nằm ngoài vùng đồng bộ đơn hằng đêm: cập nhật đơn trong hệ thống
      // theo bản mới nhất vừa tải về, trước khi đối chiếu.
      const refreshed = await refreshBookingsFromOrders(db, acc.id, [...orders.values(), ...unpaid]);
      sum.bookingsUpdated += refreshed.updated;
      sum.bookingsCreated += refreshed.created;

      // Đơn tương ứng trong hệ thống, theo mã đơn Dayladau
      const allIds = [...new Set([...payouts.flatMap(idsOf), ...unpaid.map((o) => String(o?.id ?? ""))])].filter(Boolean);
      const booked = new Map<string, { id: string; netAmount: number }>();
      for (let i = 0; i < allIds.length; i += 500) {
        const rows = await db
          .select({ id: bookings.id, externalId: bookings.externalId, netAmount: bookings.netAmount })
          .from(bookings)
          .where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.externalId, allIds.slice(i, i + 500))));
        for (const r of rows) booked.set(r.externalId!, { id: r.id, netAmount: r.netAmount });
      }

      const lineRow = (orderId: string, o: RawOrder | undefined, payoutId: string | null) => {
        const m = o ? mapPayoutOrder(o) : null;
        const amount = m?.amount ?? 0;
        const b = booked.get(orderId);
        const { status, diff } = matchLine(amount, b);
        return {
          payoutId, dayladauAccountId: acc.id, orderId,
          listingKey: m?.listingKey ?? null, listingName: m?.listingName ?? null, guestName: m?.guestName ?? null,
          checkIn: m?.checkIn ?? null, checkOut: m?.checkOut ?? null, orderStatus: m?.orderStatus ?? (o ? null : "không lấy được đơn"),
          source: m?.source ?? null, grossAmount: m?.grossAmount ?? 0, amount,
          bookingId: b?.id ?? null, bookingNet: b?.netAmount ?? null, matchStatus: status, diffAmount: diff,
        };
      };

      await db.transaction(async (tx) => {
        for (const p of payouts) {
          const ids = idsOf(p);
          const createdMs = num(p.created_at);
          const values = {
            dayladauAccountId: acc.id, investorId: acc.investorId, externalId: String(p.id),
            createdOnDayladauAt: new Date(createdMs), payoutDate: toVNDate(createdMs)!, amount: Math.round(num(p.amount)),
            status: String(p.status ?? ""), confirmedAt: num(p.confirmed_at) ? new Date(num(p.confirmed_at)) : null,
            orderCount: ids.length, itemsTotal: 0, pictureUrl: p.picture_url || null, transferRef: p.transfer_ref || null, note: p.note || null,
            lastSyncedAt: new Date(),
          };
          const [row] = await tx
            .insert(dayladauPayouts).values(values)
            .onConflictDoUpdate({ target: dayladauPayouts.externalId, set: values })
            .returning({ id: dayladauPayouts.id });
          const lines = ids.map((oid) => lineRow(oid, orders.get(oid), row.id));
          const itemsTotal = lines.reduce((s, l) => s + l.amount, 0);
          await tx.update(dayladauPayouts).set({ itemsTotal }).where(eq(dayladauPayouts.id, row.id));
          await tx.delete(dayladauPayoutItems).where(eq(dayladauPayoutItems.payoutId, row.id));
          for (let i = 0; i < lines.length; i += 500) if (lines.length) await tx.insert(dayladauPayoutItems).values(lines.slice(i, i + 500));
          sum.payouts++;
          sum.orders += lines.length;
          for (const l of lines) sum[l.matchStatus === "MATCHED" ? "matched" : l.matchStatus === "AMOUNT_DIFF" ? "amountDiff" : "notFound"]++;
          if (p.status !== "cancelled" && Math.abs(itemsTotal - values.amount) > DL_PAYOUT_TOLERANCE) sum.totalMismatch++;
        }
        // Danh sách chờ trả: thay mới hoàn toàn
        await tx.delete(dayladauPayoutItems).where(and(eq(dayladauPayoutItems.dayladauAccountId, acc.id), isNull(dayladauPayoutItems.payoutId)));
        const pendingLines = unpaid.filter((o) => o?.id !== undefined && o?.id !== null).map((o) => lineRow(String(o.id), o, null));
        for (let i = 0; i < pendingLines.length; i += 500) await tx.insert(dayladauPayoutItems).values(pendingLines.slice(i, i + 500));
        sum.pending += pendingLines.length;
      });
    } catch (e) {
      sum.errors.push({ accountId: acc.id, investorId: acc.investorId, message: (e as Error).message });
    }
  }
  return sum;
}

/**
 * Đối chiếu lại các dòng đã lưu với đơn hiện tại trong hệ thống, không gọi Dayladau.
 * Dùng sau khi đồng bộ đơn (đơn mới về hoặc tiền đơn thay đổi).
 */
export async function rematchDayladauPayoutItems(db: DB, accountIds?: string[]): Promise<number> {
  const items = await db
    .select({ id: dayladauPayoutItems.id, orderId: dayladauPayoutItems.orderId, amount: dayladauPayoutItems.amount, matchStatus: dayladauPayoutItems.matchStatus, bookingNet: dayladauPayoutItems.bookingNet, orderStatus: dayladauPayoutItems.orderStatus })
    .from(dayladauPayoutItems)
    .where(accountIds?.length ? inArray(dayladauPayoutItems.dayladauAccountId, accountIds) : undefined);
  let changed = 0;
  for (let i = 0; i < items.length; i += 500) {
    const part = items.slice(i, i + 500);
    const rows = await db.select({ id: bookings.id, externalId: bookings.externalId, netAmount: bookings.netAmount }).from(bookings)
      .where(and(eq(bookings.source, "DAYLADAU"), inArray(bookings.externalId, part.map((p) => p.orderId))));
    const by = new Map(rows.map((r) => [r.externalId!, r]));
    for (const it of part) {
      const b = by.get(it.orderId);
      const { status, diff } = matchLine(it.amount, b);
      if (status === it.matchStatus && (b?.netAmount ?? null) === it.bookingNet) continue;
      await db.update(dayladauPayoutItems).set({ bookingId: b?.id ?? null, bookingNet: b?.netAmount ?? null, matchStatus: status, diffAmount: diff }).where(eq(dayladauPayoutItems.id, it.id));
      changed++;
    }
  }
  return changed;
}

// ---------- Đọc cho trang ----------

export interface DlPayoutLine {
  id: string;
  orderId: string;
  listingName: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  orderStatus: string | null;
  source: string | null;
  grossAmount: number;
  amount: number;
  bookingId: string | null;
  roomId: string | null;
  bookingNet: number | null;
  matchStatus: MatchStatus;
  diffAmount: number | null;
}

export interface DlPayoutView {
  id: string;
  externalId: string;
  investorId: string;
  investorName: string;
  accountLabel: string;
  hostId: string;
  payoutDate: string;
  createdAt: Date;
  amount: number;
  itemsTotal: number;
  status: string;
  pictureUrl: string | null;
  lines: DlPayoutLine[];
}

export interface DlAccountView {
  id: string;
  label: string;
  hostId: string;
  investorId: string;
  investorName: string;
}

/**
 * Phiếu Dayladau tạo trong tháng (theo ngày tạo phiếu, giờ VN) và các đơn đang chờ trả, chỉ của NĐT người dùng được xem.
 * hostId: chỉ lấy tài khoản có host ID này; accounts luôn trả đủ để dựng bộ lọc.
 */
export async function dayladauPayoutsForMonth(db: DB, user: SessionUser, month: string, hostId?: string): Promise<{ payouts: DlPayoutView[]; pending: (DlPayoutLine & { accountLabel: string; hostId: string; investorName: string })[]; accounts: DlAccountView[] }>{
  const invIds = await allowedInvestorIds(db, user);
  if (!invIds.length) return { payouts: [], pending: [], accounts: [] };
  const accounts = await db
    .select({ id: dayladauAccounts.id, label: dayladauAccounts.label, hostId: dayladauAccounts.hostId, investorId: dayladauAccounts.investorId, investorName: investors.name })
    .from(dayladauAccounts)
    .innerJoin(investors, eq(investors.id, dayladauAccounts.investorId))
    .where(and(inArray(dayladauAccounts.investorId, invIds), eq(dayladauAccounts.active, true)))
    .orderBy(asc(investors.name), asc(dayladauAccounts.label));
  const picked = hostId ? accounts.filter((a) => a.hostId === hostId) : accounts;
  if (!picked.length) return { payouts: [], pending: [], accounts };
  const accById = new Map(picked.map((a) => [a.id, a]));
  const accIds = picked.map((a) => a.id);

  const ps = await db
    .select().from(dayladauPayouts)
    .where(and(inArray(dayladauPayouts.dayladauAccountId, accIds), gte(dayladauPayouts.payoutDate, D.firstDay(month)), lte(dayladauPayouts.payoutDate, D.lastDay(month))))
    .orderBy(asc(dayladauPayouts.payoutDate), asc(dayladauPayouts.createdOnDayladauAt));

  const lineCols = {
    id: dayladauPayoutItems.id, payoutId: dayladauPayoutItems.payoutId, accountId: dayladauPayoutItems.dayladauAccountId, orderId: dayladauPayoutItems.orderId,
    listingName: dayladauPayoutItems.listingName, guestName: dayladauPayoutItems.guestName, checkIn: dayladauPayoutItems.checkIn, checkOut: dayladauPayoutItems.checkOut,
    orderStatus: dayladauPayoutItems.orderStatus, source: dayladauPayoutItems.source, grossAmount: dayladauPayoutItems.grossAmount, amount: dayladauPayoutItems.amount,
    bookingId: dayladauPayoutItems.bookingId, roomId: bookings.roomId, bookingNet: dayladauPayoutItems.bookingNet, matchStatus: dayladauPayoutItems.matchStatus, diffAmount: dayladauPayoutItems.diffAmount,
  };
  const lines = ps.length
    ? await db.select(lineCols).from(dayladauPayoutItems).leftJoin(bookings, eq(bookings.id, dayladauPayoutItems.bookingId))
        .where(inArray(dayladauPayoutItems.payoutId, ps.map((p) => p.id))).orderBy(asc(dayladauPayoutItems.checkIn))
    : [];
  const pend = await db.select(lineCols).from(dayladauPayoutItems).leftJoin(bookings, eq(bookings.id, dayladauPayoutItems.bookingId))
    .where(and(inArray(dayladauPayoutItems.dayladauAccountId, accIds), isNull(dayladauPayoutItems.payoutId))).orderBy(asc(dayladauPayoutItems.checkIn));

  const byPayout = new Map<string, DlPayoutLine[]>();
  for (const { payoutId, accountId, ...l } of lines) (byPayout.get(payoutId!) ?? byPayout.set(payoutId!, []).get(payoutId!)!).push(l as DlPayoutLine);
  // Dòng lệch / chưa thấy đơn lên đầu để dễ thấy
  const rank: Record<MatchStatus, number> = { NOT_FOUND: 0, AMOUNT_DIFF: 1, MATCHED: 2 };
  const payouts = ps.map((p) => {
    const a = accById.get(p.dayladauAccountId)!;
    return {
      id: p.id, externalId: p.externalId, investorId: p.investorId, investorName: a.investorName, accountLabel: a.label, hostId: a.hostId,
      payoutDate: p.payoutDate, createdAt: p.createdOnDayladauAt, amount: p.amount, itemsTotal: p.itemsTotal, status: p.status, pictureUrl: p.pictureUrl,
      lines: (byPayout.get(p.id) ?? []).sort((x, y) => rank[x.matchStatus] - rank[y.matchStatus]),
    };
  });
  const pending = pend.map(({ payoutId, accountId, ...l }) => ({ ...(l as DlPayoutLine), accountLabel: accById.get(accountId)!.label, hostId: accById.get(accountId)!.hostId, investorName: accById.get(accountId)!.investorName }));
  return { payouts, pending, accounts };
}

/** Kiểm tra quyền đồng bộ: Admin, hoặc người được xem quyết toán của NĐT sở hữu tài khoản. */
export async function syncableAccountIds(db: DB, user: SessionUser, accountId?: string): Promise<string[]> {
  const invIds = await allowedInvestorIds(db, user);
  if (!invIds.length) return [];
  const rows = await db.select({ id: dayladauAccounts.id }).from(dayladauAccounts).where(and(inArray(dayladauAccounts.investorId, invIds), eq(dayladauAccounts.active, true)));
  const ids = rows.map((r) => r.id);
  if (accountId && !ids.includes(accountId)) throw badRequest("Không tìm thấy tài khoản Dayladau");
  return accountId ? [accountId] : ids;
}

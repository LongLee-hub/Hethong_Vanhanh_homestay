// Payout Airbnb đọc từ Gmail của từng NĐT: kết nối hộp thư, đồng bộ email, đối soát với đơn trong hệ thống.
// Đối soát: mỗi đơn trong email payout khớp với booking theo mã xác nhận Airbnb (HM…), so tiền Airbnb chuyển
// với "thực nhận" đang ghi. Đơn Airbnb đã check-in mà chưa thấy payout cũng được liệt kê.
import { and, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { airbnbListingRooms, airbnbPayoutItems, airbnbPayouts, bookings, gmailAccounts, investors, properties, rooms } from "../db/schema";
import { allowedInvestorIds, badRequest, notFound, type SessionUser } from "../auth/access";
import { decryptSecret, encryptSecret } from "../services/settings";
import { httpGmailClient, type GmailClient } from "../gmail/client";
import { accessToken as googleAccessToken } from "../gmail/oauth";
import { loadGoogleConfig } from "../gmail/config";
import { createHash } from "node:crypto";
import { extractNickname, parsePayoutEmail, prorate, splitStay, TAX_TYPES, type ParsedPayout } from "./payout-parser";
import { listingKeyOf, PAYOUT_SOURCE, payoutExternalId, syncPayoutBookings, type PayoutBookingSummary } from "./payout-bookings";

export { listingKeyOf };

/** Lệch tối thiểu (VND) coi là khớp, xem thêm PAYOUT_TOLERANCE_PCT. */
export const PAYOUT_TOLERANCE = 2_000;
/** Lần đồng bộ đầu đọc lại email của chừng này ngày. */
export const FIRST_SYNC_DAYS = 180;
/** Các lần sau đọc lùi thêm vài ngày trước lần đồng bộ trước, phòng email đến trễ. */
const OVERLAP_DAYS = 7;
export const MAX_MESSAGES = 500;
/** Đọc lùi: tối đa chừng này email mỗi lần bấm (vừa thời gian một yêu cầu 300 giây). */
export const MAX_BACKFILL = 300;
/** Số email tải song song khi đọc lùi. */
const FETCH_CONCURRENCY = 5;
/** Airbnb thường chuyển tiền khoảng 24 giờ sau giờ nhận phòng; quá số ngày này mà chưa có payout thì báo thiếu. */
export const MISSING_AFTER_DAYS = 3;
/** Đối soát lại các payout trong khoảng này (đơn có thể đồng bộ về sau email payout). */
const REMATCH_DAYS = 180;

// Giống searchPayoutThreads của Apps Script: email từ automated@airbnb.com có dòng tổng chi trả hoặc tiêu đề payout
export const GMAIL_QUERY = 'from:automated@airbnb.com {"Tổng số tiền đã chi trả" "Total paid out" subject:"chi trả" subject:payout}';

// ---------- Quyền ----------

/** Admin kết nối Gmail cho mọi NĐT; NĐT tự kết nối Gmail của mình. Kế toán chỉ xem. */
export async function canManageGmail(db: DB, user: SessionUser, investorId: string): Promise<boolean> {
  if (user.role === "ADMIN") return true;
  if (user.role !== "INVESTOR") return false;
  return (await allowedInvestorIds(db, user)).includes(investorId);
}

async function requireManage(db: DB, user: SessionUser, investorId: string) {
  if (!(await canManageGmail(db, user, investorId))) throw notFound("Không tìm thấy nhà đầu tư");
}

// ---------- Kết nối Gmail ----------

export interface GmailConnection {
  id: string;
  investorId: string;
  investorName: string;
  email: string;
  active: boolean;
  lastSyncedAt: Date | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  canManage: boolean;
}

export async function listGmailAccounts(db: DB, user: SessionUser): Promise<GmailConnection[]> {
  const inv = await allowedInvestorIds(db, user);
  if (!inv.length) return [];
  const rows = await db
    .select({ a: gmailAccounts, investorName: investors.name })
    .from(gmailAccounts)
    .innerJoin(investors, eq(investors.id, gmailAccounts.investorId))
    .where(inArray(gmailAccounts.investorId, inv))
    .orderBy(investors.name, gmailAccounts.email);
  const out: GmailConnection[] = [];
  for (const { a, investorName } of rows) {
    out.push({
      id: a.id, investorId: a.investorId, investorName, email: a.email, active: a.active,
      lastSyncedAt: a.lastSyncedAt, lastSyncStatus: a.lastSyncStatus, lastSyncError: a.lastSyncError,
      canManage: await canManageGmail(db, user, a.investorId),
    });
  }
  return out;
}

/** Lưu Gmail vừa đồng ý quyền. Một hộp thư chỉ thuộc một NĐT; kết nối lại cùng hộp thư thì thay refresh token. */
export async function saveGmailConnection(
  db: DB,
  user: SessionUser,
  input: { investorId: string; email: string; refreshToken: string },
  encrypt = encryptSecret,
) {
  await requireManage(db, user, input.investorId);
  const email = input.email.trim().toLowerCase();
  if (!email || !input.refreshToken) throw badRequest("Thiếu thông tin Gmail");
  const [existing] = await db.select().from(gmailAccounts).where(eq(gmailAccounts.email, email)).limit(1);
  if (existing && existing.investorId !== input.investorId) throw badRequest(`Gmail ${email} đã gắn với nhà đầu tư khác`);
  const values = { refreshTokenEncrypted: encrypt(input.refreshToken), active: true, connectedById: user.id, lastSyncStatus: null, lastSyncError: null };
  if (existing) {
    const [row] = await db.update(gmailAccounts).set(values).where(eq(gmailAccounts.id, existing.id)).returning();
    return row;
  }
  const [row] = await db.insert(gmailAccounts).values({ investorId: input.investorId, email, ...values }).returning();
  return row;
}

/** Ngắt kết nối: xóa refresh token, giữ lại các payout đã đọc. */
export async function disconnectGmail(db: DB, user: SessionUser, accountId: string) {
  const [a] = await db.select().from(gmailAccounts).where(eq(gmailAccounts.id, accountId)).limit(1);
  if (!a) throw notFound("Không tìm thấy Gmail");
  await requireManage(db, user, a.investorId);
  await db.update(gmailAccounts).set({ active: false, refreshTokenEncrypted: "" }).where(eq(gmailAccounts.id, accountId));
}

// ---------- Đồng bộ ----------

export interface PayoutSyncSummary {
  accounts: number;
  messages: number;
  created: number;
  skipped: number;
  /** Email Airbnb gửi lặp cùng một "Mã khoản chi trả" — bỏ qua. */
  duplicates: number;
  matched: number;
  /** Số đơn (mã đặt phòng khác nhau) trong các email vừa thêm. */
  bookings: number;
  /** Ngày gửi tiền cũ nhất / mới nhất trong các email vừa thêm. */
  oldest: string | null;
  newest: string | null;
  errors: { accountId: string; email: string; message: string }[];
  /** Đơn dựng từ payout cho phòng đã gán (doanh thu đơn không có trong Dayladau). */
  revenue?: PayoutBookingSummary;
}

/**
 * Đọc lùi email cũ: count = số email payout gần nhất cần đọc (mới → cũ); since/until (YYYY-MM-DD, tính cả hai đầu)
 * giới hạn theo ngày nhận email. Email đã có trong hệ thống được bỏ qua nên bấm lại nhiều lần vẫn an toàn.
 */
export interface BackfillOptions {
  count?: number;
  since?: string;
  until?: string;
}

export interface PayoutSyncDeps {
  client?: GmailClient;
  /** refresh token → access token */
  accessToken?: (refreshToken: string) => Promise<string>;
  decrypt?: (s: string) => string;
  today?: string;
}

const gmailDate = (d: string) => d.replace(/-/g, "/");

async function insertParsed(db: DB, base: { gmailAccountId: string | null; investorId: string; gmailMessageId: string; receivedAt: Date; subject: string | null; bodyText: string }, p: ParsedPayout) {
  const [payout] = await db
    .insert(airbnbPayouts)
    .values({
      ...base,
      payoutDate: D.todayVN(base.receivedAt),
      amount: p.amount ?? 0,
      currency: p.currency,
      payoutCode: p.payoutCode,
      totalUsd: p.totalUsd,
      exchangeRate: p.exchangeRate,
      parseStatus: p.status,
      parseNote: p.note,
    })
    .onConflictDoNothing()
    .returning();
  if (!payout) return null; // lượt đồng bộ khác đã lưu email này
  if (p.items.length) await db.insert(airbnbPayoutItems).values(p.items.map((i) => ({ payoutId: payout.id, ...i })));
  return payout;
}

async function payoutCodeExists(db: DB, investorId: string, code: string | null): Promise<boolean> {
  if (!code) return false;
  const [r] = await db.select({ id: airbnbPayouts.id }).from(airbnbPayouts).where(and(eq(airbnbPayouts.investorId, investorId), eq(airbnbPayouts.payoutCode, code))).limit(1);
  return !!r;
}

/** Các email đã lưu giữ tối đa chừng này ký tự thân thư (đủ cho email payout nhiều đơn). */
const MAX_BODY = 60_000;

/** Câu tìm Gmail và số email tối đa cho một tài khoản. */
export function gmailSearch(a: { lastSyncedAt: Date | null }, today: string, backfill?: BackfillOptions): { query: string; max: number } {
  if (!backfill) {
    const since = a.lastSyncedAt ? D.addDays(D.todayVN(a.lastSyncedAt), -OVERLAP_DAYS) : D.addDays(today, -FIRST_SYNC_DAYS);
    return { query: `${GMAIL_QUERY} after:${gmailDate(since)}`, max: MAX_MESSAGES };
  }
  // Gmail: after: và before: tính theo ngày, before: không gồm chính ngày đó
  let query = GMAIL_QUERY;
  if (backfill.since) query += ` after:${gmailDate(D.addDays(backfill.since, -1))}`;
  if (backfill.until) query += ` before:${gmailDate(D.addDays(backfill.until, 1))}`;
  return { query, max: Math.min(Math.max(1, Math.floor(backfill.count ?? MAX_BACKFILL)), MAX_BACKFILL) };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateBackfill(b: BackfillOptions, today: string): BackfillOptions {
  const out: BackfillOptions = {};
  if (b.count !== undefined) {
    if (!Number.isInteger(b.count) || b.count < 1) throw badRequest("Số email phải là số nguyên dương");
    if (b.count > MAX_BACKFILL) throw badRequest(`Mỗi lần đọc tối đa ${MAX_BACKFILL} email, bấm thêm lần nữa để đọc tiếp`);
    out.count = b.count;
  }
  for (const k of ["since", "until"] as const) {
    if (!b[k]) continue;
    if (!DATE_RE.test(b[k]!)) throw badRequest("Ngày không hợp lệ");
    if (b[k]! > today) throw badRequest("Ngày không được sau hôm nay");
    out[k] = b[k];
  }
  if (out.since && out.until && out.since > out.until) throw badRequest("Từ ngày phải trước đến ngày");
  if (out.count === undefined && !out.since) throw badRequest("Chọn số email cần đọc hoặc ngày bắt đầu");
  return out;
}

export async function syncPayouts(db: DB, opts: PayoutSyncDeps & { accountIds?: string[]; investorIds?: string[]; backfill?: BackfillOptions } = {}): Promise<PayoutSyncSummary> {
  const client = opts.client ?? httpGmailClient;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const sum: PayoutSyncSummary = { accounts: 0, messages: 0, created: 0, skipped: 0, duplicates: 0, matched: 0, bookings: 0, oldest: null, newest: null, errors: [] };
  const createdIds: string[] = [];
  const codes = new Set<string>();

  const conds = [eq(gmailAccounts.active, true)];
  if (opts.accountIds?.length) conds.push(inArray(gmailAccounts.id, opts.accountIds));
  if (opts.investorIds?.length) conds.push(inArray(gmailAccounts.investorId, opts.investorIds));
  const accounts = await db.select().from(gmailAccounts).where(and(...conds));
  if (!accounts.length) {
    // Lượt đồng bộ chung (cron) vẫn dựng lại đơn từ payout, kể cả NĐT chỉ dán email tay
    if (!opts.accountIds?.length && !opts.investorIds?.length) sum.revenue = await reconcilePayoutRevenue(db, opts.today);
    return sum;
  }

  let getToken = opts.accessToken;
  if (!getToken) {
    const cfg = await loadGoogleConfig(db, decrypt);
    getToken = (r) => googleAccessToken(cfg, r);
  }

  for (const a of accounts) {
    if (!a.refreshTokenEncrypted) continue;
    sum.accounts++;
    try {
      const at = await getToken(decrypt(a.refreshTokenEncrypted));
      const { query, max } = gmailSearch(a, today, opts.backfill);
      const ids = await client.listMessageIds(at, query, max);
      sum.messages += ids.length;
      const stored = new Set<string>();
      for (let k = 0; k < ids.length; k += 500) {
        const part = ids.slice(k, k + 500);
        for (const r of await db.select({ id: airbnbPayouts.gmailMessageId }).from(airbnbPayouts).where(and(eq(airbnbPayouts.gmailAccountId, a.id), inArray(airbnbPayouts.gmailMessageId, part)))) stored.add(r.id);
      }
      const todo = ids.filter((id) => !stored.has(id));
      // Tải vài email song song, ghi lần lượt (để kiểm tra trùng mã khoản chi trả đúng thứ tự)
      for (let k = 0; k < todo.length; k += FETCH_CONCURRENCY) {
        const msgs = await Promise.all(todo.slice(k, k + FETCH_CONCURRENCY).map((id) => client.getMessage(at, id)));
        for (const msg of msgs) {
          const parsed = parsePayoutEmail({ subject: msg.subject, text: msg.text, payDate: D.todayVN(msg.receivedAt) });
          if (!parsed.isPayout) { sum.skipped++; continue; }
          if (await payoutCodeExists(db, a.investorId, parsed.payoutCode)) { sum.duplicates++; continue; }
          const row = await insertParsed(db, { gmailAccountId: a.id, investorId: a.investorId, gmailMessageId: msg.id, receivedAt: msg.receivedAt, subject: msg.subject, bodyText: msg.text.slice(0, MAX_BODY) }, parsed);
          if (!row) continue;
          sum.created++;
          createdIds.push(row.id);
          for (const i of parsed.items) if (i.confirmationCode) codes.add(`${a.investorId}|${i.confirmationCode}`);
          if (!sum.oldest || row.payoutDate < sum.oldest) sum.oldest = row.payoutDate;
          if (!sum.newest || row.payoutDate > sum.newest) sum.newest = row.payoutDate;
        }
      }
      // Đọc lùi không dời mốc đọc hằng ngày (lần đọc thường kế tiếp vẫn lùi đủ 180 ngày nếu chưa đọc lần nào)
      await db
        .update(gmailAccounts)
        .set(opts.backfill ? { lastSyncStatus: "OK", lastSyncError: null } : { lastSyncedAt: new Date(), lastSyncStatus: "OK", lastSyncError: null })
        .where(eq(gmailAccounts.id, a.id));
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      sum.errors.push({ accountId: a.id, email: a.email, message });
      await db.update(gmailAccounts).set({ lastSyncStatus: "FAILED", lastSyncError: message }).where(eq(gmailAccounts.id, a.id));
    }
  }

  sum.bookings = codes.size;
  const investorIds = [...new Set(accounts.map((a) => a.investorId))];
  // Đọc lùi: đối soát đúng các email vừa thêm (có thể cũ hơn khoảng đối soát lại hằng ngày)
  sum.matched = opts.backfill
    ? createdIds.length ? await matchPayouts(db, { payoutIds: createdIds }) : 0
    : await matchPayouts(db, { investorIds, today });
  // Lượt chung (cron) dựng lại cho mọi NĐT, kể cả NĐT chỉ dán email tay
  sum.revenue = await syncPayoutBookings(db, opts.accountIds?.length || opts.investorIds?.length ? investorIds : undefined);
  return sum;
}

/** Đối soát lại payout gần đây rồi dựng lại đơn từ payout cho mọi NĐT. Gọi sau khi đồng bộ đơn Dayladau để hủy đơn payout đã có đơn thật. */
export async function reconcilePayoutRevenue(db: DB, today?: string): Promise<PayoutBookingSummary> {
  await matchPayouts(db, { today });
  return syncPayoutBookings(db);
}

// ---------- Đối soát ----------
// Một đơn có nhiều dòng (tiền phòng, phí dọn, thuế TNCN/VAT âm) và có thể nằm ở nhiều email payout.
// So tổng VNĐ Airbnb đã chuyển cho đơn (mọi dòng, kể cả thuế khấu trừ âm, cộng dồn mọi email) với "thực nhận"
// đang ghi: Dayladau "Amount host" là tiền host nhận sau khi đã trừ hết thuế phí (anh Long xác nhận 21/10/2026).
// Dòng USD được quy ra VNĐ theo tỷ giá ngày chuyển tiền, còn Dayladau quy đổi lúc đặt phòng, nên cho lệch trong
// khoảng PAYOUT_TOLERANCE_PCT. TODO(CONFIRM) mức chênh tỷ giá chấp nhận được.

/** Lệch trong khoảng max(PAYOUT_TOLERANCE ₫, PAYOUT_TOLERANCE_PCT % thực nhận) coi là khớp. */
export const PAYOUT_TOLERANCE_PCT = 3;
export const toleranceFor = (net: number) => Math.max(PAYOUT_TOLERANCE, Math.round((Math.abs(net) * PAYOUT_TOLERANCE_PCT) / 100));

type BookingRow = { id: string; netAmount: number };

/** Tìm đơn của NĐT theo mã đặt phòng: mã có thể là external_id hoặc nằm đâu đó trong dữ liệu gốc Dayladau. */
async function findByCode(db: DB, propIds: string[], code: string): Promise<BookingRow | null> {
  const rows = await db
    .select({ id: bookings.id, netAmount: bookings.netAmount })
    .from(bookings)
    .where(and(inArray(bookings.propertyId, propIds), ne(bookings.source, PAYOUT_SOURCE), sql`(${bookings.externalId} = ${code} or ${bookings.rawPayload}::text like ${`%${code}%`})`))
    .limit(2);
  return rows.length === 1 ? rows[0] : null; // hai đơn cùng mã: không đoán, để người dùng xem
}

/** Dự phòng khi dữ liệu Dayladau không chứa mã đặt phòng Airbnb: cùng tên khách và ngày nhận phòng, kênh Airbnb. */
async function findByGuest(db: DB, propIds: string[], guest: string, checkIn: string): Promise<BookingRow | null> {
  const rows = await db
    .select({ id: bookings.id, netAmount: bookings.netAmount })
    .from(bookings)
    .where(and(inArray(bookings.propertyId, propIds), ne(bookings.source, PAYOUT_SOURCE), eq(bookings.checkIn, checkIn), ilike(bookings.channel, "%airbnb%"), sql`lower(${bookings.guestName}) = lower(${guest})`))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

/** Trạng thái của cả đơn: paidVnd = VNĐ sau thuế Airbnb đã chuyển cho đơn (mọi email), null khi chưa quy được ra VNĐ. */
export function matchStatus(paidVnd: number | null, booking: BookingRow | null): { matchStatus: "MATCHED" | "AMOUNT_DIFF" | "NOT_FOUND"; diffAmount: number | null } {
  if (!booking) return { matchStatus: "NOT_FOUND", diffAmount: null };
  if (paidVnd === null) return { matchStatus: "MATCHED", diffAmount: null };
  const diff = paidVnd - booking.netAmount;
  return { matchStatus: Math.abs(diff) <= toleranceFor(booking.netAmount) ? "MATCHED" : "AMOUNT_DIFF", diffAmount: diff };
}

/** Đối soát lại các dòng payout gần đây. Trả số đơn khớp được. */
export async function matchPayouts(db: DB, opts: { investorIds?: string[]; payoutIds?: string[]; today?: string } = {}): Promise<number> {
  const today = opts.today ?? D.todayVN();
  const conds = [eq(airbnbPayouts.currency, "VND")];
  if (opts.payoutIds?.length) conds.push(inArray(airbnbPayouts.id, opts.payoutIds));
  else conds.push(gte(airbnbPayouts.payoutDate, D.addDays(today, -REMATCH_DAYS)));
  if (opts.investorIds?.length) conds.push(inArray(airbnbPayouts.investorId, opts.investorIds));
  const rows = await db
    .select({ item: airbnbPayoutItems, investorId: airbnbPayouts.investorId })
    .from(airbnbPayoutItems)
    .innerJoin(airbnbPayouts, eq(airbnbPayouts.id, airbnbPayoutItems.payoutId))
    .where(and(...conds));

  // 1. Gắn đơn: theo mã (mỗi mã tìm một lần), dòng không có mã thì theo tên khách + ngày nhận phòng
  const propsOf = new Map<string, string[]>();
  const byCode = new Map<string, BookingRow | null>();
  const touched = new Set<string>(); // đơn cần tính lại số lệch (cả đơn cũ của dòng vừa đổi gắn)
  for (const { item, investorId } of rows) {
    if (!propsOf.has(investorId)) propsOf.set(investorId, (await db.select({ id: properties.id }).from(properties).where(eq(properties.investorId, investorId))).map((p) => p.id));
    const propIds = propsOf.get(investorId)!;
    let b: BookingRow | null = null;
    if (propIds.length && item.confirmationCode) {
      const k = `${investorId}|${item.confirmationCode}`;
      if (!byCode.has(k)) byCode.set(k, await findByCode(db, propIds, item.confirmationCode));
      b = byCode.get(k)!;
    }
    // Mã không có trong dữ liệu Dayladau (hoặc dòng không có mã): thử tên khách + ngày nhận phòng
    if (!b && propIds.length && item.guestName && item.checkIn) b = await findByGuest(db, propIds, item.guestName, item.checkIn);
    if (item.bookingId) touched.add(item.bookingId);
    if (b) {
      touched.add(b.id);
      if (item.bookingId !== b.id) await db.update(airbnbPayoutItems).set({ bookingId: b.id }).where(eq(airbnbPayoutItems.id, item.id));
    } else if (item.bookingId !== null || item.matchStatus !== "NOT_FOUND" || item.diffAmount !== null) {
      await db.update(airbnbPayoutItems).set({ bookingId: null, ...matchStatus(null, null) }).where(eq(airbnbPayoutItems.id, item.id));
    }
  }
  if (!touched.size) return 0;

  // 2. Mỗi đơn: cộng VNĐ mọi dòng đã gắn (mọi email, sau thuế), so với thực nhận, ghi cho mọi dòng của đơn
  const ids = [...touched];
  const [lines, nets] = await Promise.all([
    db.select({ id: airbnbPayoutItems.id, bookingId: airbnbPayoutItems.bookingId, lineType: airbnbPayoutItems.lineType, amount: airbnbPayoutItems.amount, matchStatus: airbnbPayoutItems.matchStatus, diffAmount: airbnbPayoutItems.diffAmount })
      .from(airbnbPayoutItems).where(inArray(airbnbPayoutItems.bookingId, ids)),
    db.select({ id: bookings.id, netAmount: bookings.netAmount }).from(bookings).where(inArray(bookings.id, ids)),
  ]);
  const paid = new Map<string, number | null>();
  for (const l of lines) {
    if (!l.bookingId) continue;
    const cur = paid.has(l.bookingId) ? paid.get(l.bookingId)! : 0;
    paid.set(l.bookingId, cur === null || l.amount === null ? null : cur + l.amount);
  }
  const netOf = new Map(nets.map((n) => [n.id, n]));
  let matched = 0;
  for (const id of ids) {
    if (!lines.some((l) => l.bookingId === id)) continue;
    matched++;
    const st = matchStatus(paid.has(id) ? paid.get(id)! : 0, netOf.get(id) ?? null);
    for (const l of lines) {
      if (l.bookingId === id && (l.matchStatus !== st.matchStatus || l.diffAmount !== st.diffAmount)) {
        await db.update(airbnbPayoutItems).set(st).where(eq(airbnbPayoutItems.id, l.id));
      }
    }
  }
  return matched;
}

// ---------- Dán email payout trên web ----------
// Dùng khi chưa kết nối Gmail, hoặc để thử bộ tách với một email thật: mở email payout, chọn toàn bộ nội dung, dán vào.

/** Xem trước kết quả tách, chưa lưu. Giữ nguyên khoảng trắng trong dòng (tên khách và số tiền cách nhau ≥ 2 dấu cách). */
export function previewPastedPayout(input: { text: string; receivedOn?: string | null }): ParsedPayout {
  return parsePayoutEmail({ subject: "", text: input.text.replace(/\r/g, ""), payDate: input.receivedOn ?? null });
}

export async function importPastedPayout(db: DB, user: SessionUser, input: { investorId: string; subject?: string; text: string; receivedOn: string }) {
  await requireManage(db, user, input.investorId);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.receivedOn)) throw badRequest("Chọn ngày nhận email");
  if (input.text.trim().length < 20) throw badRequest("Dán toàn bộ nội dung email payout");
  const parsed = previewPastedPayout(input);
  if (!parsed.isPayout) throw badRequest(`${parsed.skipReason}. Dán cả phần cuối email, có dòng tổng tiền`);
  if (await payoutCodeExists(db, input.investorId, parsed.payoutCode)) throw badRequest(`Khoản chi trả ${parsed.payoutCode} đã có trong hệ thống`);
  const text = input.text.replace(/\r/g, "").slice(0, MAX_BODY);
  const messageId = "paste:" + createHash("sha256").update(text).digest("hex").slice(0, 24);
  const [dup] = await db.select({ id: airbnbPayouts.id }).from(airbnbPayouts).where(and(eq(airbnbPayouts.investorId, input.investorId), eq(airbnbPayouts.gmailMessageId, messageId))).limit(1);
  if (dup) throw badRequest("Email này đã được dán trước đó");
  const row = await insertParsed(
    db,
    { gmailAccountId: null, investorId: input.investorId, gmailMessageId: messageId, receivedAt: new Date(`${input.receivedOn}T12:00:00+07:00`), subject: input.subject?.trim() || null, bodyText: text },
    parsed,
  );
  if (row) {
    await matchPayouts(db, { payoutIds: [row.id] });
    await syncPayoutBookings(db, [input.investorId]);
  }
  return row;
}

/** Xóa payout dán tay (dán nhầm). Payout đọc từ Gmail không xóa được, vì lần đồng bộ sau sẽ đọc lại. */
export async function deletePastedPayout(db: DB, user: SessionUser, payoutId: string) {
  const [p] = await db.select().from(airbnbPayouts).where(eq(airbnbPayouts.id, payoutId)).limit(1);
  if (!p) throw notFound("Không tìm thấy payout");
  await requireManage(db, user, p.investorId);
  if (p.gmailAccountId) throw badRequest("Chỉ xóa được email dán tay");
  const affected = (await db.selectDistinct({ id: airbnbPayoutItems.bookingId }).from(airbnbPayoutItems).where(eq(airbnbPayoutItems.payoutId, p.id))).map((r) => r.id).filter((x): x is string => !!x);
  await db.delete(airbnbPayouts).where(eq(airbnbPayouts.id, p.id));
  await rematchBookings(db, affected);
  await syncPayoutBookings(db, [p.investorId]);
}

/** Tính lại số lệch của các đơn khi một email bị xóa hoặc tách lại. */
async function rematchBookings(db: DB, bookingIds: string[]) {
  if (!bookingIds.length) return;
  const ps = await db.selectDistinct({ id: airbnbPayoutItems.payoutId }).from(airbnbPayoutItems).where(inArray(airbnbPayoutItems.bookingId, bookingIds));
  if (ps.length) await matchPayouts(db, { payoutIds: ps.map((p) => p.id) });
}

/** Tách lại một email đã lưu (sau khi sửa bộ tách), rồi đối soát lại. */
export async function reparsePayout(db: DB, user: SessionUser, payoutId: string) {
  const [p] = await db.select().from(airbnbPayouts).where(eq(airbnbPayouts.id, payoutId)).limit(1);
  if (!p) throw notFound("Không tìm thấy payout");
  await requireManage(db, user, p.investorId);
  const parsed = parsePayoutEmail({ subject: p.subject ?? "", text: p.bodyText ?? "", payDate: p.payoutDate });
  const affected = (await db.selectDistinct({ id: airbnbPayoutItems.bookingId }).from(airbnbPayoutItems).where(eq(airbnbPayoutItems.payoutId, p.id))).map((r) => r.id).filter((x): x is string => !!x);
  await db.delete(airbnbPayoutItems).where(eq(airbnbPayoutItems.payoutId, p.id));
  await db
    .update(airbnbPayouts)
    .set({
      amount: parsed.amount ?? 0, currency: parsed.currency, payoutCode: parsed.payoutCode, totalUsd: parsed.totalUsd, exchangeRate: parsed.exchangeRate,
      parseStatus: parsed.isPayout ? parsed.status : "FAILED", parseNote: parsed.isPayout ? parsed.note : parsed.skipReason ?? null,
    })
    .where(eq(airbnbPayouts.id, p.id));
  if (parsed.items.length) await db.insert(airbnbPayoutItems).values(parsed.items.map((i) => ({ payoutId: p.id, ...i })));
  await matchPayouts(db, { payoutIds: [p.id] });
  await rematchBookings(db, affected);
  await syncPayoutBookings(db, [p.investorId]);
}

// ---------- Gán phòng cho listing Airbnb ----------
// Dòng payout chưa khớp được đơn (đơn chưa đồng bộ, hoặc không có trong Dayladau) thì chưa biết thuộc phòng nào.
// Người quản lý Gmail của NĐT gán tay phòng cho listing Airbnb; gán một lần, áp dụng cho mọi payout của listing.

/** roomId = null: bỏ gán. Phòng phải thuộc một cơ sở của chính NĐT đó. */
/** Gán xong thì dựng lại đơn từ payout của NĐT, để doanh thu tính vào phòng vừa gán. */
export async function assignListingRoom(db: DB, user: SessionUser, input: { investorId: string; listingKey: string; roomId: string | null }): Promise<PayoutBookingSummary> {
  await requireManage(db, user, input.investorId);
  const listingKey = input.listingKey.trim();
  if (!listingKey) throw badRequest("Thiếu listing Airbnb");
  if (!input.roomId) {
    await db.delete(airbnbListingRooms).where(and(eq(airbnbListingRooms.investorId, input.investorId), eq(airbnbListingRooms.listingKey, listingKey)));
    return syncPayoutBookings(db, [input.investorId]);
  }
  const [r] = await db
    .select({ id: rooms.id })
    .from(rooms)
    .innerJoin(properties, eq(properties.id, rooms.propertyId))
    .where(and(eq(rooms.id, input.roomId), eq(properties.investorId, input.investorId)))
    .limit(1);
  if (!r) throw badRequest("Phòng không thuộc nhà đầu tư này");
  await db
    .insert(airbnbListingRooms)
    .values({ investorId: input.investorId, listingKey, roomId: r.id })
    .onConflictDoUpdate({ target: [airbnbListingRooms.investorId, airbnbListingRooms.listingKey], set: { roomId: r.id } });
  return syncPayoutBookings(db, [input.investorId]);
}

/** Phòng đã gán theo listing: khóa `${investorId}|${listingKey}` → roomId. */
async function listingRoomMap(db: DB, investorIds: string[]): Promise<Map<string, string>> {
  if (!investorIds.length) return new Map();
  const rs = await db.select().from(airbnbListingRooms).where(inArray(airbnbListingRooms.investorId, investorIds));
  return new Map(rs.map((r) => [`${r.investorId}|${r.listingKey}`, r.roomId]));
}

// ---------- Xem theo lần chuyển tiền ----------

export interface PayoutLine {
  id: string;
  lineType: string | null;
  usdAmount: number | null;
  amount: number | null;
}

/** Các dòng cùng mã đặt phòng (và cùng ngày ở) trong một email, gộp lại như sheet "Booking Summary". */
export interface PayoutBookingGroup {
  key: string;
  confirmationCode: string | null;
  guestName: string | null;
  listingName: string | null;
  listingId: string | null;
  /** Khóa listing để gán phòng (null = email không ghi listing). */
  listingKey: string | null;
  /** Phòng gán tay theo listing; chỉ dùng khi chưa khớp đơn. */
  assignedRoomId: string | null;
  /** Đã dựng đơn từ payout: doanh thu mã này đang tính vào phòng đã gán. */
  revenueBooked: boolean;
  checkIn: string | null;
  checkOut: string | null;
  lines: PayoutLine[];
  usd: number;
  vnd: number | null; // thực nhận sau thuế trong email này
  preTaxVnd: number | null;
  taxVnd: number | null;
  matchStatus: "MATCHED" | "AMOUNT_DIFF" | "NOT_FOUND";
  diffAmount: number | null; // cả đơn: VNĐ sau thuế cộng dồn mọi email − thực nhận
  booking: { id: string; roomId: string; guestName: string | null; checkIn: string; checkOut: string; netAmount: number; status: string } | null;
}

export interface PayoutView {
  id: string;
  investorId: string;
  investorName: string;
  /** null = email dán tay trên web */
  email: string | null;
  payoutDate: string;
  amount: number;
  currency: string;
  payoutCode: string | null;
  totalUsd: number | null;
  exchangeRate: number | null;
  subject: string | null;
  parseStatus: "OK" | "PARTIAL" | "FAILED";
  parseNote: string | null;
  groups: PayoutBookingGroup[];
  canManage: boolean;
}

export interface MissingPayout {
  bookingId: string;
  investorName: string;
  roomId: string;
  externalId: string | null;
  guestName: string | null;
  checkIn: string;
  checkOut: string;
  netAmount: number;
}

const sumOrNull = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<number>((s, x) => s + (x ?? 0), 0));

function groupLines<T extends { item: typeof airbnbPayoutItems.$inferSelect; b: PayoutBookingGroup["booking"] | { id: null } }>(rows: T[]): PayoutBookingGroup[] {
  const map = new Map<string, PayoutBookingGroup>();
  for (const { item: i, b } of rows) {
    const key = i.confirmationCode ? `${i.confirmationCode}|${i.checkIn ?? ""}|${i.checkOut ?? ""}` : `line|${i.id}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key, confirmationCode: i.confirmationCode, guestName: i.guestName, listingName: i.listingName, listingId: i.listingId,
        listingKey: listingKeyOf(i), assignedRoomId: null, revenueBooked: false, checkIn: i.checkIn, checkOut: i.checkOut, lines: [], usd: 0, vnd: 0, preTaxVnd: 0, taxVnd: 0,
        matchStatus: i.matchStatus, diffAmount: i.diffAmount, booking: b && b.id ? (b as PayoutBookingGroup["booking"]) : null,
      };
      map.set(key, g);
    }
    g.lines.push({ id: i.id, lineType: i.lineType, usdAmount: i.usdAmount, amount: i.amount });
  }
  // Tiền phòng trước, các khoản khác, thuế khấu trừ cuối
  const rank = (t: string | null) => (t === "Tiền phòng" ? 0 : t && TAX_TYPES.has(t) ? 2 : 1);
  for (const g of map.values()) {
    g.lines.sort((x, y) => rank(x.lineType) - rank(y.lineType) || (x.lineType ?? "").localeCompare(y.lineType ?? ""));
    g.usd = Math.round(g.lines.reduce((s, l) => s + (l.usdAmount ?? 0), 0) * 100) / 100;
    g.vnd = sumOrNull(g.lines.map((l) => l.amount));
    const isTax = (l: PayoutLine) => !!l.lineType && TAX_TYPES.has(l.lineType);
    g.preTaxVnd = sumOrNull(g.lines.filter((l) => !isTax(l)).map((l) => l.amount));
    g.taxVnd = sumOrNull(g.lines.filter(isTax).map((l) => l.amount));
  }
  return [...map.values()];
}

const bookingCols = { id: bookings.id, roomId: bookings.roomId, guestName: bookings.guestName, checkIn: bookings.checkIn, checkOut: bookings.checkOut, netAmount: bookings.netAmount, status: bookings.status };

export async function payoutsForMonth(db: DB, user: SessionUser, month: string, today = D.todayVN()): Promise<{ payouts: PayoutView[]; missing: MissingPayout[] }> {
  const inv = await allowedInvestorIds(db, user);
  if (!inv.length) return { payouts: [], missing: [] };
  const from = D.firstDay(month), to = D.lastDay(month);

  const ps = await db
    .select({ p: airbnbPayouts, investorName: investors.name, email: gmailAccounts.email })
    .from(airbnbPayouts)
    .innerJoin(investors, eq(investors.id, airbnbPayouts.investorId))
    .leftJoin(gmailAccounts, eq(gmailAccounts.id, airbnbPayouts.gmailAccountId))
    .where(and(inArray(airbnbPayouts.investorId, inv), gte(airbnbPayouts.payoutDate, from), lte(airbnbPayouts.payoutDate, to)))
    .orderBy(desc(airbnbPayouts.payoutDate), desc(airbnbPayouts.receivedAt));
  const items = ps.length
    ? await db
        .select({ item: airbnbPayoutItems, b: bookingCols })
        .from(airbnbPayoutItems)
        .leftJoin(bookings, eq(bookings.id, airbnbPayoutItems.bookingId))
        .where(inArray(airbnbPayoutItems.payoutId, ps.map((x) => x.p.id)))
        .orderBy(airbnbPayoutItems.payoutId)
    : [];
  const invIds = [...new Set(ps.map((x) => x.p.investorId))];
  const manage = new Map<string, boolean>();
  for (const id of invIds) manage.set(id, await canManageGmail(db, user, id));
  const assigned = await listingRoomMap(db, invIds);
  const codes = [...new Set(items.map((x) => x.item.confirmationCode).filter((c): c is string => !!c))];
  const booked = new Set(
    codes.length
      ? (await db.select({ externalId: bookings.externalId }).from(bookings).where(and(eq(bookings.source, PAYOUT_SOURCE), eq(bookings.status, "CONFIRMED"), inArray(bookings.externalId, codes.map(payoutExternalId))))).map((r) => r.externalId)
      : [],
  );

  const payouts: PayoutView[] = ps.map(({ p, investorName, email }) => {
    const groups = groupLines(items.filter((x) => x.item.payoutId === p.id) as { item: typeof airbnbPayoutItems.$inferSelect; b: PayoutBookingGroup["booking"] }[]);
    for (const g of groups) {
      if (g.listingKey) g.assignedRoomId = assigned.get(`${p.investorId}|${g.listingKey}`) ?? null;
      g.revenueBooked = !!g.confirmationCode && booked.has(payoutExternalId(g.confirmationCode));
    }
    return {
      id: p.id, investorId: p.investorId, investorName, email, payoutDate: p.payoutDate, amount: p.amount, currency: p.currency,
      payoutCode: p.payoutCode, totalUsd: p.totalUsd, exchangeRate: p.exchangeRate, subject: p.subject, parseStatus: p.parseStatus, parseNote: p.parseNote,
      groups, canManage: manage.get(p.investorId) ?? false,
    };
  });

  // Đơn Airbnb đã nhận phòng trong tháng mà chưa thấy payout. Chỉ xét NĐT đã kết nối Gmail và các đơn
  // nhận phòng từ ngày kết nối trở đi trừ đi số ngày đọc lại lần đầu (trước đó email chưa được đọc).
  const connected = await db
    .select({ investorId: gmailAccounts.investorId, since: sql<Date>`min(${gmailAccounts.createdAt})` })
    .from(gmailAccounts)
    .where(and(inArray(gmailAccounts.investorId, inv), isNotNull(gmailAccounts.lastSyncedAt)))
    .groupBy(gmailAccounts.investorId);
  const missing: MissingPayout[] = [];
  const latest = D.addDays(today, -MISSING_AFTER_DAYS);
  for (const c of connected) {
    const start = [from, D.addDays(D.todayVN(new Date(c.since)), -FIRST_SYNC_DAYS)].sort().at(-1)!;
    const end = [to, latest].sort()[0];
    if (start > end) continue;
    const rows = await db
      .select({ b: bookings, investorName: investors.name })
      .from(bookings)
      .innerJoin(properties, eq(properties.id, bookings.propertyId))
      .innerJoin(investors, eq(investors.id, properties.investorId))
      .where(and(
        eq(properties.investorId, c.investorId),
        eq(bookings.status, "CONFIRMED"),
        ne(bookings.source, PAYOUT_SOURCE),
        ilike(bookings.channel, "%airbnb%"),
        gte(bookings.checkIn, start),
        lte(bookings.checkIn, end),
        sql`not exists (select 1 from ${airbnbPayoutItems} where ${airbnbPayoutItems.bookingId} = ${bookings.id})`,
      ))
      .orderBy(bookings.checkIn);
    for (const { b, investorName } of rows) {
      missing.push({ bookingId: b.id, investorName, roomId: b.roomId, externalId: b.externalId, guestName: b.guestName, checkIn: b.checkIn, checkOut: b.checkOut, netAmount: b.netAmount });
    }
  }
  return { payouts, missing };
}

// ---------- Doanh thu theo tháng từ payout (sheet "Báo cáo tháng" của script) ----------

export interface MonthlyPayoutRow {
  key: string;
  investorName: string;
  confirmationCode: string | null;
  guestName: string | null;
  listingName: string | null;
  nickname: string;
  roomId: string | null; // phòng của đơn đã khớp; chưa khớp thì phòng gán tay theo listing
  checkIn: string | null; // kỳ ở đầy đủ
  checkOut: string | null;
  partCheckIn: string | null; // phần nằm trong tháng
  partCheckOut: string | null;
  nights: number | null;
  totalNights: number | null;
  vnd: number; // thực nhận sau thuế, phần của tháng
  preTaxVnd: number;
  taxVnd: number;
  usd: number;
  lastPayoutDate: string;
  /** Dòng không có ngày ở: tính vào tháng chuyển tiền. */
  noDates: boolean;
}

/**
 * Doanh thu Airbnb đã chuyển, phân bổ theo tháng ở: gộp dòng theo mã đặt phòng + ngày ở (mọi email),
 * đơn trải nhiều tháng chia theo số đêm, phần cuối nhận phần dư. Dòng không có ngày ở tính vào tháng chuyển tiền.
 */
export async function payoutRevenueByMonth(db: DB, user: SessionUser, month: string): Promise<MonthlyPayoutRow[]> {
  const inv = await allowedInvestorIds(db, user);
  if (!inv.length) return [];
  const from = D.firstDay(month), to = D.lastDay(month);
  const rows = await db
    .select({ i: airbnbPayoutItems, p: { investorId: airbnbPayouts.investorId, payoutDate: airbnbPayouts.payoutDate }, investorName: investors.name, roomId: bookings.roomId })
    .from(airbnbPayoutItems)
    .innerJoin(airbnbPayouts, eq(airbnbPayouts.id, airbnbPayoutItems.payoutId))
    .innerJoin(investors, eq(investors.id, airbnbPayouts.investorId))
    .leftJoin(bookings, eq(bookings.id, airbnbPayoutItems.bookingId))
    .where(and(
      inArray(airbnbPayouts.investorId, inv),
      eq(airbnbPayouts.currency, "VND"),
      or(
        and(lte(airbnbPayoutItems.checkIn, to), gt(airbnbPayoutItems.checkOut, from)),
        and(isNull(airbnbPayoutItems.checkIn), gte(airbnbPayouts.payoutDate, from), lte(airbnbPayouts.payoutDate, to)),
      ),
    ));

  type Acc = Omit<MonthlyPayoutRow, "partCheckIn" | "partCheckOut" | "nights" | "totalNights">;
  const map = new Map<string, Acc>();
  const assigned = await listingRoomMap(db, [...new Set(rows.map((r) => r.p.investorId))]);
  for (const { i, p, investorName, roomId: bookingRoomId } of rows) {
    const lk = listingKeyOf(i);
    const roomId = bookingRoomId ?? (lk ? assigned.get(`${p.investorId}|${lk}`) : undefined);
    const noDates = !i.checkIn || !i.checkOut;
    const key = noDates ? `line|${i.id}` : `${p.investorId}|${i.confirmationCode ?? i.guestName}|${i.checkIn}|${i.checkOut}`;
    let a = map.get(key);
    if (!a) {
      a = {
        key, investorName, confirmationCode: i.confirmationCode, guestName: i.guestName, listingName: i.listingName, nickname: extractNickname(i.listingName),
        roomId: roomId ?? null, checkIn: i.checkIn, checkOut: i.checkOut, vnd: 0, preTaxVnd: 0, taxVnd: 0, usd: 0, lastPayoutDate: p.payoutDate, noDates,
      };
      map.set(key, a);
    }
    const v = i.amount ?? 0;
    a.vnd += v;
    if (i.lineType && TAX_TYPES.has(i.lineType)) a.taxVnd += v; else a.preTaxVnd += v;
    a.usd += i.usdAmount ?? 0;
    if (p.payoutDate > a.lastPayoutDate) a.lastPayoutDate = p.payoutDate;
    a.roomId ??= roomId ?? null;
  }

  const out: MonthlyPayoutRow[] = [];
  for (const a of map.values()) {
    const parts = splitStay(a.checkIn, a.checkOut);
    if (!parts) {
      out.push({ ...a, usd: Math.round(a.usd * 100) / 100, partCheckIn: a.checkIn, partCheckOut: a.checkOut, nights: null, totalNights: null });
      continue;
    }
    const idx = parts.findIndex((x) => x.month === month);
    if (idx < 0) continue;
    const share = (n: number) => prorate(n, parts)[idx];
    const part = parts[idx];
    out.push({
      ...a, vnd: share(a.vnd), preTaxVnd: share(a.preTaxVnd), taxVnd: share(a.taxVnd), usd: prorate(a.usd, parts, 2)[idx],
      partCheckIn: part.checkIn, partCheckOut: part.checkOut, nights: part.nights, totalNights: part.totalNights,
    });
  }
  return out.sort((x, y) => (x.partCheckIn ?? x.lastPayoutDate).localeCompare(y.partCheckIn ?? y.lastPayoutDate) || (x.confirmationCode ?? "").localeCompare(y.confirmationCode ?? ""));
}

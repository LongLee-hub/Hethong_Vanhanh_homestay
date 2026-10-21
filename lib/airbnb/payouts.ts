// Payout Airbnb đọc từ Gmail của từng NĐT: kết nối hộp thư, đồng bộ email, đối soát với đơn trong hệ thống.
// Đối soát: mỗi đơn trong email payout khớp với booking theo mã xác nhận Airbnb (HM…), so tiền Airbnb chuyển
// với "thực nhận" đang ghi. Đơn Airbnb đã check-in mà chưa thấy payout cũng được liệt kê.
import { and, desc, eq, gte, ilike, inArray, isNotNull, lte, sql } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { airbnbPayoutItems, airbnbPayouts, bookings, gmailAccounts, investors, properties } from "../db/schema";
import { allowedInvestorIds, badRequest, notFound, type SessionUser } from "../auth/access";
import { decryptSecret, encryptSecret } from "../services/settings";
import { httpGmailClient, type GmailClient } from "../gmail/client";
import { accessToken as googleAccessToken } from "../gmail/oauth";
import { parsePayoutEmail, type ParsedPayout } from "./payout-parser";

/** Lệch dưới mức này (VND) coi là khớp: làm tròn tiền giữa Airbnb và Dayladau. */
export const PAYOUT_TOLERANCE = 2_000;
/** Lần đồng bộ đầu đọc lại email của chừng này ngày. */
export const FIRST_SYNC_DAYS = 180;
/** Các lần sau đọc lùi thêm vài ngày trước lần đồng bộ trước, phòng email đến trễ. */
const OVERLAP_DAYS = 7;
export const MAX_MESSAGES = 500;
/** Airbnb thường chuyển tiền khoảng 24 giờ sau giờ nhận phòng; quá số ngày này mà chưa có payout thì báo thiếu. */
export const MISSING_AFTER_DAYS = 3;
/** Đối soát lại các payout trong khoảng này (đơn có thể đồng bộ về sau email payout). */
const REMATCH_DAYS = 180;

export const GMAIL_QUERY = 'from:airbnb.com {payout "khoản thanh toán" "khoản chi trả"}';

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
  matched: number;
  errors: { accountId: string; email: string; message: string }[];
}

export interface PayoutSyncDeps {
  client?: GmailClient;
  /** refresh token → access token */
  accessToken?: (refreshToken: string) => Promise<string>;
  decrypt?: (s: string) => string;
  today?: string;
}

const gmailDate = (d: string) => d.replace(/-/g, "/");

async function insertParsed(db: DB, base: { gmailAccountId: string; investorId: string; gmailMessageId: string; receivedAt: Date; subject: string; bodyText: string }, p: ParsedPayout) {
  const [payout] = await db
    .insert(airbnbPayouts)
    .values({
      ...base,
      payoutDate: D.todayVN(base.receivedAt),
      amount: p.amount ?? 0,
      currency: p.currency,
      parseStatus: p.status,
      parseNote: p.note,
    })
    .onConflictDoNothing()
    .returning();
  if (!payout) return null; // lượt đồng bộ khác đã lưu email này
  if (p.items.length) await db.insert(airbnbPayoutItems).values(p.items.map((i) => ({ payoutId: payout.id, ...i })));
  return payout;
}

/** Các email đã lưu giữ tối đa chừng này ký tự thân thư (đủ cho email payout nhiều đơn). */
const MAX_BODY = 60_000;

export async function syncPayouts(db: DB, opts: PayoutSyncDeps & { accountIds?: string[]; investorIds?: string[] } = {}): Promise<PayoutSyncSummary> {
  const client = opts.client ?? httpGmailClient;
  const getToken = opts.accessToken ?? googleAccessToken;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const sum: PayoutSyncSummary = { accounts: 0, messages: 0, created: 0, skipped: 0, matched: 0, errors: [] };

  const conds = [eq(gmailAccounts.active, true)];
  if (opts.accountIds?.length) conds.push(inArray(gmailAccounts.id, opts.accountIds));
  if (opts.investorIds?.length) conds.push(inArray(gmailAccounts.investorId, opts.investorIds));
  const accounts = await db.select().from(gmailAccounts).where(and(...conds));

  for (const a of accounts) {
    if (!a.refreshTokenEncrypted) continue;
    sum.accounts++;
    try {
      const at = await getToken(decrypt(a.refreshTokenEncrypted));
      const since = a.lastSyncedAt ? D.addDays(D.todayVN(a.lastSyncedAt), -OVERLAP_DAYS) : D.addDays(today, -FIRST_SYNC_DAYS);
      const ids = await client.listMessageIds(at, `${GMAIL_QUERY} after:${gmailDate(since)}`, MAX_MESSAGES);
      sum.messages += ids.length;
      const stored = new Set(
        ids.length
          ? (await db.select({ id: airbnbPayouts.gmailMessageId }).from(airbnbPayouts).where(and(eq(airbnbPayouts.gmailAccountId, a.id), inArray(airbnbPayouts.gmailMessageId, ids)))).map((r) => r.id)
          : [],
      );
      for (const id of ids) {
        if (stored.has(id)) continue;
        const msg = await client.getMessage(at, id);
        const parsed = parsePayoutEmail({ subject: msg.subject, text: msg.text });
        if (!parsed.isPayout) { sum.skipped++; continue; }
        const row = await insertParsed(db, { gmailAccountId: a.id, investorId: a.investorId, gmailMessageId: msg.id, receivedAt: msg.receivedAt, subject: msg.subject, bodyText: msg.text.slice(0, MAX_BODY) }, parsed);
        if (row) sum.created++;
      }
      await db.update(gmailAccounts).set({ lastSyncedAt: new Date(), lastSyncStatus: "OK", lastSyncError: null }).where(eq(gmailAccounts.id, a.id));
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      sum.errors.push({ accountId: a.id, email: a.email, message });
      await db.update(gmailAccounts).set({ lastSyncStatus: "FAILED", lastSyncError: message }).where(eq(gmailAccounts.id, a.id));
    }
  }

  const investorIds = [...new Set(accounts.map((a) => a.investorId))];
  if (investorIds.length) sum.matched = await matchPayouts(db, { investorIds, today });
  return sum;
}

// ---------- Đối soát ----------

type BookingRow = { id: string; netAmount: number };

/** Tìm đơn của NĐT theo mã HM: mã có thể là external_id hoặc nằm đâu đó trong dữ liệu gốc Dayladau. */
async function findByCode(db: DB, propIds: string[], code: string): Promise<BookingRow | null> {
  const rows = await db
    .select({ id: bookings.id, netAmount: bookings.netAmount })
    .from(bookings)
    .where(and(inArray(bookings.propertyId, propIds), sql`(${bookings.externalId} = ${code} or ${bookings.rawPayload}::text like ${`%${code}%`})`))
    .limit(2);
  return rows.length === 1 ? rows[0] : null; // hai đơn cùng mã: không đoán, để người dùng xem
}

/** Dự phòng khi dữ liệu Dayladau không chứa mã HM: cùng tên khách và ngày nhận phòng, kênh Airbnb. */
async function findByGuest(db: DB, propIds: string[], guest: string, checkIn: string): Promise<BookingRow | null> {
  const rows = await db
    .select({ id: bookings.id, netAmount: bookings.netAmount })
    .from(bookings)
    .where(and(inArray(bookings.propertyId, propIds), eq(bookings.checkIn, checkIn), ilike(bookings.channel, "%airbnb%"), sql`lower(${bookings.guestName}) = lower(${guest})`))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}

export function matchStatus(itemAmount: number | null, booking: BookingRow | null): { matchStatus: "MATCHED" | "AMOUNT_DIFF" | "NOT_FOUND"; diffAmount: number | null } {
  if (!booking) return { matchStatus: "NOT_FOUND", diffAmount: null };
  if (itemAmount === null) return { matchStatus: "MATCHED", diffAmount: null };
  const diff = itemAmount - booking.netAmount;
  return { matchStatus: Math.abs(diff) <= PAYOUT_TOLERANCE ? "MATCHED" : "AMOUNT_DIFF", diffAmount: diff };
}

/** Đối soát lại các dòng payout gần đây. Trả số dòng khớp được đơn. */
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
  const propsOf = new Map<string, string[]>();
  let matched = 0;
  for (const { item, investorId } of rows) {
    if (!propsOf.has(investorId)) propsOf.set(investorId, (await db.select({ id: properties.id }).from(properties).where(eq(properties.investorId, investorId))).map((p) => p.id));
    const propIds = propsOf.get(investorId)!;
    let b: BookingRow | null = null;
    if (propIds.length) {
      if (item.confirmationCode) b = await findByCode(db, propIds, item.confirmationCode);
      if (!b && item.guestName && item.checkIn) b = await findByGuest(db, propIds, item.guestName, item.checkIn);
    }
    const st = matchStatus(item.amount, b);
    if (b) matched++;
    if (item.bookingId !== (b?.id ?? null) || item.matchStatus !== st.matchStatus || item.diffAmount !== st.diffAmount) {
      await db.update(airbnbPayoutItems).set({ bookingId: b?.id ?? null, ...st }).where(eq(airbnbPayoutItems.id, item.id));
    }
  }
  return matched;
}

/** Tách lại một email đã lưu (sau khi sửa bộ tách), rồi đối soát lại. */
export async function reparsePayout(db: DB, user: SessionUser, payoutId: string) {
  const [p] = await db.select().from(airbnbPayouts).where(eq(airbnbPayouts.id, payoutId)).limit(1);
  if (!p) throw notFound("Không tìm thấy payout");
  await requireManage(db, user, p.investorId);
  const parsed = parsePayoutEmail({ subject: p.subject ?? "", text: p.bodyText ?? "" });
  await db.delete(airbnbPayoutItems).where(eq(airbnbPayoutItems.payoutId, p.id));
  await db.update(airbnbPayouts).set({ amount: parsed.amount ?? 0, currency: parsed.currency, parseStatus: parsed.isPayout ? parsed.status : "FAILED", parseNote: parsed.isPayout ? parsed.note : parsed.skipReason ?? null }).where(eq(airbnbPayouts.id, p.id));
  if (parsed.items.length) await db.insert(airbnbPayoutItems).values(parsed.items.map((i) => ({ payoutId: p.id, ...i })));
  await matchPayouts(db, { payoutIds: [p.id] });
}

// ---------- Xem theo tháng ----------

export interface PayoutItemView {
  id: string;
  confirmationCode: string | null;
  guestName: string | null;
  checkIn: string | null;
  checkOut: string | null;
  amount: number | null;
  matchStatus: "MATCHED" | "AMOUNT_DIFF" | "NOT_FOUND";
  diffAmount: number | null;
  booking: { id: string; roomId: string; guestName: string | null; checkIn: string; checkOut: string; netAmount: number; status: string } | null;
}

export interface PayoutView {
  id: string;
  investorId: string;
  investorName: string;
  email: string;
  payoutDate: string;
  amount: number;
  currency: string;
  subject: string | null;
  parseStatus: "OK" | "PARTIAL" | "FAILED";
  parseNote: string | null;
  items: PayoutItemView[];
  /** Tổng thực nhận của các đơn đã khớp, để so với tổng payout khi email không ghi tiền từng đơn. */
  matchedNet: number;
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

export async function payoutsForMonth(db: DB, user: SessionUser, month: string, today = D.todayVN()): Promise<{ payouts: PayoutView[]; missing: MissingPayout[] }> {
  const inv = await allowedInvestorIds(db, user);
  if (!inv.length) return { payouts: [], missing: [] };
  const from = D.firstDay(month), to = D.lastDay(month);

  const ps = await db
    .select({ p: airbnbPayouts, investorName: investors.name, email: gmailAccounts.email })
    .from(airbnbPayouts)
    .innerJoin(investors, eq(investors.id, airbnbPayouts.investorId))
    .innerJoin(gmailAccounts, eq(gmailAccounts.id, airbnbPayouts.gmailAccountId))
    .where(and(inArray(airbnbPayouts.investorId, inv), gte(airbnbPayouts.payoutDate, from), lte(airbnbPayouts.payoutDate, to)))
    .orderBy(desc(airbnbPayouts.payoutDate), desc(airbnbPayouts.receivedAt));
  const items = ps.length
    ? await db
        .select({ i: airbnbPayoutItems, b: { id: bookings.id, roomId: bookings.roomId, guestName: bookings.guestName, checkIn: bookings.checkIn, checkOut: bookings.checkOut, netAmount: bookings.netAmount, status: bookings.status } })
        .from(airbnbPayoutItems)
        .leftJoin(bookings, eq(bookings.id, airbnbPayoutItems.bookingId))
        .where(inArray(airbnbPayoutItems.payoutId, ps.map((x) => x.p.id)))
    : [];
  const manage = new Map<string, boolean>();
  for (const id of new Set(ps.map((x) => x.p.investorId))) manage.set(id, await canManageGmail(db, user, id));

  const payouts: PayoutView[] = ps.map(({ p, investorName, email }) => {
    const its = items.filter((x) => x.i.payoutId === p.id).map(({ i, b }) => ({
      id: i.id, confirmationCode: i.confirmationCode, guestName: i.guestName, checkIn: i.checkIn, checkOut: i.checkOut, amount: i.amount,
      matchStatus: i.matchStatus, diffAmount: i.diffAmount, booking: b?.id ? b : null,
    }));
    return {
      id: p.id, investorId: p.investorId, investorName, email, payoutDate: p.payoutDate, amount: p.amount, currency: p.currency, subject: p.subject,
      parseStatus: p.parseStatus, parseNote: p.parseNote, items: its, matchedNet: its.reduce((s, i) => s + (i.booking?.netAmount ?? 0), 0),
      canManage: manage.get(p.investorId) ?? false,
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

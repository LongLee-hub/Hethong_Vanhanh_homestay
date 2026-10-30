// Đồng bộ đánh giá của khách từ Dayladau, theo script Apps Script "capNhapReview" của LOCI:
//   GET https://api.dayladau.com/v1/reviews?host_id=&limit=&offset=&x_access_token=
//   Trả về { reviews: [...] }. Mỗi review: id, overall, location, accuracy, checkin, cleanliness, communication, comment,
//   user.fullname, reservation.start_time / end_time, listing.id / name.
// Chạy cùng job đồng bộ đơn (06:00 hằng ngày và khi Admin bấm "Đồng bộ ngay").
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { alerts, dayladauAccounts, investors, properties, reviews } from "../db/schema";
import { decryptSecret, notifyLark } from "../services/settings";
import { DAYLADAU_BASE, PAGE_SIZE, redact, withRetry } from "./client";
import { toVNDate, type RawOrder } from "./mapping";
import { listingRef, roomsByListing } from "./room-listings";

/** Đánh giá có điểm tổng thể dưới mức này (thang 5) là đánh giá thấp: báo Lark và hiện trong mục cần chú ý. */
export const LOW_REVIEW_SCORE = 4;
/** Chỉ báo đánh giá thấp mới trả phòng trong chừng này ngày, để lần đồng bộ đầu không báo lại cả lịch sử. */
export const LOW_REVIEW_ALERT_DAYS = 30;
export const REVIEW_MAX = 5000;

export type RawReview = RawOrder;
export type ReviewFetcher = (hostId: string, token: string, max: number) => Promise<RawReview[]>;

export const SCORE_FIELDS = ["location", "accuracy", "checkin", "cleanliness", "communication"] as const;
export type ScoreField = (typeof SCORE_FIELDS)[number];

export interface MappedReview {
  externalId: string;
  listingKey: string;
  listingName: string;
  guestName: string | null;
  overall: number | null;
  scores: Record<ScoreField, number | null>;
  comment: string | null;
  checkIn: string | null;
  checkOut: string | null;
  /** Ngày dùng để xếp đánh giá vào tháng: ngày trả phòng, không có thì ngày viết đánh giá. */
  reviewDate: string;
}

export function reviewsUrl(hostId: string, token: string, offset: number, limit = PAGE_SIZE): string {
  const u = new URL(`${DAYLADAU_BASE}/v1/reviews`);
  u.searchParams.set("host_id", hostId);
  u.searchParams.set("limit", String(limit));
  u.searchParams.set("offset", String(offset));
  u.searchParams.set("x_access_token", token);
  return u.toString();
}

async function fetchReviewsPage(hostId: string, token: string, offset: number): Promise<RawReview[]> {
  return withRetry(async () => {
    let r: Response;
    try {
      r = await fetch(reviewsUrl(hostId, token, offset), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(redact(`Không kết nối được Dayladau (review): ${(e as Error).message}`, token));
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Host ID hoặc access token không hợp lệ (HTTP ${r.status})`);
    if (!r.ok) throw new Error(`Dayladau trả lỗi HTTP ${r.status} khi lấy review`);
    const data = (await r.json()) as { reviews?: RawReview[] };
    if (!Array.isArray(data.reviews)) throw new Error("Phản hồi Dayladau không có danh sách reviews");
    return data.reviews;
  });
}

/** Lấy mọi trang review. Dừng khi hết trang, hoặc khi một trang không thêm review mới (API bỏ qua offset). */
export const httpReviewFetcher: ReviewFetcher = async (hostId, token, max) => {
  const byId = new Map<string, RawReview>();
  for (let offset = 0; offset < max; offset += PAGE_SIZE) {
    const page = await fetchReviewsPage(hostId, token, offset);
    const before = byId.size;
    for (const r of page) if (r?.id !== undefined && r?.id !== null) byId.set(String(r.id), r);
    if (page.length < PAGE_SIZE || byId.size === before) break;
  }
  return [...byId.values()];
};

/** Điểm hợp lệ hoặc null (0 / trống = khách không chấm tiêu chí này). */
function score(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export function mapDayladauReview(r: RawReview): MappedReview {
  const externalId = String(r?.id ?? "").trim();
  if (!externalId) throw new Error("Review Dayladau không có id");
  const checkIn = toVNDate(r?.reservation?.start_time);
  const checkOut = toVNDate(r?.reservation?.end_time);
  const written = toVNDate(r?.created_at ?? r?.createdAt ?? r?.updated_at);
  const reviewDate = checkOut ?? written ?? checkIn;
  if (!reviewDate) throw new Error(`Review ${externalId}: thiếu ngày trả phòng`);
  const listingName = String(r?.listing?.name ?? "").trim();
  const listingId = r?.listing?.id ?? r?.listing_id;
  const comment = String(r?.comment ?? "").trim();
  return {
    externalId,
    listingKey: listingId !== undefined && listingId !== null && listingId !== "" ? String(listingId) : listingName,
    listingName: listingName || "không rõ",
    guestName: r?.user?.fullname ? String(r.user.fullname).trim() : null,
    overall: score(r?.overall),
    scores: Object.fromEntries(SCORE_FIELDS.map((f) => [f, score(r?.[f])])) as Record<ScoreField, number | null>,
    comment: comment || null,
    checkIn,
    checkOut,
    reviewDate,
  };
}

export const isLowReview = (overall: number | null) => overall !== null && overall < LOW_REVIEW_SCORE;

export interface ReviewSyncSummary {
  created: number;
  updated: number;
  skipped: number;
  lowAlerts: number;
  unmapped: { account: string; listing: string; count: number }[];
  errors: { accountId: string; message: string }[];
}

export async function syncReviews(
  db: DB,
  opts: { fetch?: ReviewFetcher; decrypt?: (s: string) => string; today?: string; accountIds?: string[] } = {},
): Promise<ReviewSyncSummary> {
  const fetchAll = opts.fetch ?? httpReviewFetcher;
  const decrypt = opts.decrypt ?? decryptSecret;
  const today = opts.today ?? D.todayVN();
  const sum: ReviewSyncSummary = { created: 0, updated: 0, skipped: 0, lowAlerts: 0, unmapped: [], errors: [] };

  const conds = [eq(dayladauAccounts.active, true)];
  if (opts.accountIds?.length) conds.push(inArray(dayladauAccounts.id, opts.accountIds));
  const accs = await db
    .select({ acc: dayladauAccounts, investorName: investors.name })
    .from(dayladauAccounts)
    .innerJoin(investors, eq(investors.id, dayladauAccounts.investorId))
    .where(and(...conds));
  const byListing = await roomsByListing(db, accs.map((a) => a.acc.id));
  const lowLines: string[] = [];

  for (const { acc, investorName } of accs) {
    const who = `${investorName} · ${acc.label}`;
    try {
      const props = await db.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.dayladauAccountId, acc.id));
      if (!props.length) continue; // tài khoản chưa gắn cơ sở nào: không có chỗ ghi đánh giá
      const pids = props.map((p) => p.id);
      const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));
      const roomOf = (key: string) => {
        const r = byListing.get(listingRef(acc.id, key));
        return r && pids.includes(r.propertyId) ? r : undefined;
      };

      const raws = await fetchAll(acc.hostId, decrypt(acc.tokenEncrypted), REVIEW_MAX);
      const mapped: { m: MappedReview; raw: RawReview; propertyId: string; roomId: string | null }[] = [];
      const unmapped = new Map<string, { name: string; count: number }>();
      for (const raw of raws) {
        let m: MappedReview;
        try {
          m = mapDayladauReview(raw);
        } catch (e) {
          sum.skipped++;
          sum.errors.push({ accountId: acc.id, message: (e as Error).message });
          continue;
        }
        const room = roomOf(m.listingKey) ?? roomOf(m.listingName);
        // Listing chưa gắn phòng: tài khoản chỉ dùng cho một cơ sở thì vẫn ghi vào cơ sở đó (không rõ phòng)
        const propertyId = room?.propertyId ?? (pids.length === 1 ? pids[0] : null);
        if (!propertyId) {
          sum.skipped++;
          const u = unmapped.get(m.listingKey) ?? { name: m.listingName, count: 0 };
          u.count++;
          unmapped.set(m.listingKey, u);
          continue;
        }
        mapped.push({ m, raw, propertyId, roomId: room?.id ?? null });
      }

      const known = new Set<string>();
      const ids = mapped.map((x) => x.m.externalId);
      for (let i = 0; i < ids.length; i += 500) {
        const rows = await db.select({ externalId: reviews.externalId }).from(reviews).where(inArray(reviews.externalId, ids.slice(i, i + 500)));
        for (const r of rows) known.add(r.externalId!);
      }

      const alertFrom = D.addDays(today, -LOW_REVIEW_ALERT_DAYS);
      for (const { m, raw, propertyId, roomId } of mapped) {
        const values = {
          propertyId, roomId, channel: "Dayladau", score: String(m.overall ?? 0), reviewDate: m.reviewDate, content: m.comment,
          dayladauAccountId: acc.id, externalId: m.externalId, guestName: m.guestName, listingName: m.listingName,
          ...m.scores, checkIn: m.checkIn, checkOut: m.checkOut, rawPayload: raw, lastSyncedAt: new Date(),
        };
        const { externalId: _key, ...changes } = values;
        await db.insert(reviews).values(values).onConflictDoUpdate({ target: reviews.externalId, set: changes });
        if (known.has(m.externalId)) {
          sum.updated++;
          continue;
        }
        sum.created++;
        if (isLowReview(m.overall) && m.reviewDate >= alertFrom) {
          const msg = `${propName[propertyId]} · ${m.listingName}: khách ${m.guestName ?? "không rõ tên"} chấm ${m.overall}★ (trả phòng ${D.formatDateVN(m.reviewDate)})${m.comment ? ` – "${m.comment.slice(0, 140)}"` : ""}`;
          const [inserted] = await db
            .insert(alerts)
            .values({ type: "BAD_REVIEW", key: `BAD_REVIEW:${m.externalId}`, propertyId, month: D.monthOf(m.reviewDate), message: `Đánh giá thấp: ${msg}` })
            .onConflictDoNothing()
            .returning({ id: alerts.id });
          if (inserted) {
            sum.lowAlerts++;
            lowLines.push(msg);
          }
        }
      }
      for (const [, u] of unmapped) sum.unmapped.push({ account: who, listing: u.name, count: u.count });
    } catch (e) {
      // Lỗi lấy review của một tài khoản không dừng các tài khoản khác, cũng không làm hỏng đồng bộ đơn
      sum.errors.push({ accountId: acc.id, message: `${who}: ${(e as Error).message}` });
    }
  }

  if (lowLines.length) await notifyLark(db, `LOCI – đánh giá thấp mới:\n• ${lowLines.join("\n• ")}`);
  return sum;
}

/** Đánh giá của các cơ sở có ngày trả phòng trong khoảng [from, to]. */
export const reviewsInRange = (db: DB, propertyIds: string[], from: string, to: string) =>
  propertyIds.length
    ? db.select().from(reviews).where(and(inArray(reviews.propertyId, propertyIds), gte(reviews.reviewDate, from), lte(reviews.reviewDate, to)))
    : Promise.resolve([] as (typeof reviews.$inferSelect)[]);

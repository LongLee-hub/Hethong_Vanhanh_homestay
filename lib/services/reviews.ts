// Tổng hợp đánh giá theo tháng (tháng khách trả phòng), theo từng cơ sở. Luôn lọc theo cơ sở người xem được phép.
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { alerts, bookingNights, properties, reviews, rooms } from "../db/schema";
import { allowedPropertyIds, type SessionUser } from "../auth/access";
import { isLowReview, reviewsInRange, SCORE_FIELDS, type ScoreField } from "../dayladau/reviews";
import { notifyLark } from "./settings";

type ReviewRow = typeof reviews.$inferSelect;
export type Criterion = "overall" | ScoreField;
export const CRITERIA: Criterion[] = ["overall", ...SCORE_FIELDS];
export const CRITERION_LABEL: Record<Criterion, string> = {
  overall: "Tổng thể", location: "Vị trí", accuracy: "Đúng mô tả", checkin: "Nhận phòng", cleanliness: "Sạch sẽ", communication: "Giao tiếp",
};

export interface ReviewStats {
  count: number;
  /** Điểm trung bình mỗi tiêu chí, bỏ qua lượt không chấm; null = chưa có lượt chấm nào. */
  avg: Record<Criterion, number | null>;
  low: number;
  fiveStar: number;
  /** Tổng thể từ 4 đến dưới 5. */
  fourStar: number;
}

/** Một dòng của bảng "Theo phòng": đánh giá trong tháng cạnh doanh thu, KPI và số đơn của phòng đó. */
export interface RoomReviewRow {
  /** null = đánh giá chưa gắn được phòng. */
  roomId: string | null;
  roomName: string;
  stats: ReviewStats;
  /** Doanh thu tháng (đã trừ hoa hồng OTA), cộng theo đêm. */
  revenue: number;
  /** KPI doanh thu tháng của phòng, null = chưa đặt. */
  revenueKpi: number | null;
  /** Doanh thu ÷ KPI, null khi chưa đặt KPI. */
  kpiPct: number | null;
  /** Số đơn có đêm ở trong tháng. */
  bookings: number;
}

const overallOf = (r: ReviewRow) => (Number(r.score) > 0 ? Number(r.score) : null);
const valueOf = (r: ReviewRow, c: Criterion) => (c === "overall" ? overallOf(r) : r[c]);

export function statsOf(rows: ReviewRow[]): ReviewStats {
  const avg = {} as Record<Criterion, number | null>;
  for (const c of CRITERIA) {
    const vs = rows.map((r) => valueOf(r, c)).filter((v): v is number => v !== null && v > 0);
    avg[c] = vs.length ? Math.round((vs.reduce((s, v) => s + v, 0) / vs.length) * 100) / 100 : null;
  }
  const four = rows.filter((r) => { const v = overallOf(r); return v !== null && v >= 4 && v < 5; }).length;
  return { count: rows.length, avg, low: rows.filter((r) => isLowReview(overallOf(r))).length, fiveStar: rows.filter((r) => overallOf(r) === 5).length, fourStar: four };
}

export interface ReviewItem {
  id: string;
  propertyId: string;
  propertyName: string;
  roomName: string | null;
  listingName: string | null;
  guestName: string | null;
  reviewDate: string;
  checkIn: string | null;
  checkOut: string | null;
  overall: number | null;
  scores: Record<ScoreField, number | null>;
  content: string | null;
  low: boolean;
}

export interface MonthlyReviewSummary {
  month: string;
  /** Tháng đang chạy: số liệu tính đến hôm nay và còn thay đổi đến hết tháng. */
  inProgress: boolean;
  asOf: string;
  total: ReviewStats;
  prevTotal: ReviewStats;
  byProperty: { propertyId: string; name: string; stats: ReviewStats; prevOverall: number | null; rooms: RoomReviewRow[]; revenue: number; revenueKpi: number | null; kpiPct: number | null; bookings: number }[];
  items: ReviewItem[];
}

export async function monthlyReviewSummary(db: DB, user: SessionUser, month: string, today = D.todayVN()): Promise<MonthlyReviewSummary> {
  const ids = await allowedPropertyIds(db, user);
  const prev = D.prevMonth(month);
  const from = D.firstDay(month);
  const to = D.lastDay(month);
  const [cur, before, props, rs, rev] = await Promise.all([
    reviewsInRange(db, ids, from, to),
    reviewsInRange(db, ids, D.firstDay(prev), D.lastDay(prev)),
    ids.length ? db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ids)).orderBy(asc(properties.name)) : [],
    ids.length
      ? db.select({ id: rooms.id, name: rooms.name, propertyId: rooms.propertyId, openedOn: rooms.openedOn, closedOn: rooms.closedOn, kpi: rooms.revenueKpiMonthly }).from(rooms).where(inArray(rooms.propertyId, ids))
      : [],
    ids.length
      ? db
          .select({
            roomId: bookingNights.roomId,
            revenue: sql<number>`COALESCE(SUM(${bookingNights.netAmount}), 0)::bigint`,
            bookings: sql<number>`COUNT(DISTINCT ${bookingNights.bookingId})::int`,
          })
          .from(bookingNights)
          .where(and(inArray(bookingNights.propertyId, ids), gte(bookingNights.nightDate, from), lte(bookingNights.nightDate, to)))
          .groupBy(bookingNights.roomId)
      : [],
  ]);
  const revByRoom = new Map(rev.map((r) => [r.roomId, { revenue: Number(r.revenue), bookings: Number(r.bookings) }]));
  const pct = (revenue: number, kpi: number | null) => (kpi ? Math.round((revenue / kpi) * 10000) / 100 : null);
  /** Phòng mở trong tháng, hoặc có đánh giá / doanh thu trong tháng (phòng vừa đóng vẫn hiện). */
  const roomsOf = (pid: string, mine: ReviewRow[]): RoomReviewRow[] => {
    const list = rs
      .filter((r) => r.propertyId === pid)
      .filter((r) => (r.openedOn <= to && (!r.closedOn || r.closedOn >= from)) || revByRoom.has(r.id) || mine.some((v) => v.roomId === r.id))
      .map((r) => {
        const m = revByRoom.get(r.id) ?? { revenue: 0, bookings: 0 };
        const kpi = r.kpi > 0 ? r.kpi : null;
        return { roomId: r.id, roomName: r.name, stats: statsOf(mine.filter((v) => v.roomId === r.id)), revenue: m.revenue, revenueKpi: kpi, kpiPct: pct(m.revenue, kpi), bookings: m.bookings };
      })
      .sort((a, b) => a.roomName.localeCompare(b.roomName, "vi", { numeric: true }));
    const known = new Set<string | null>(list.map((r) => r.roomId));
    const out: RoomReviewRow[] = list;
    const orphan = mine.filter((v) => !v.roomId || !known.has(v.roomId));
    if (orphan.length) out.push({ roomId: null, roomName: "Chưa gắn phòng", stats: statsOf(orphan), revenue: 0, revenueKpi: null, kpiPct: null, bookings: 0 });
    return out;
  };
  const roomName = Object.fromEntries(rs.map((r) => [r.id, r.name]));
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));

  const byProperty = props
    .map((p) => {
      const mine = cur.filter((r) => r.propertyId === p.id);
      const roomRows = roomsOf(p.id, mine);
      const revenue = roomRows.reduce((s, r) => s + r.revenue, 0);
      const kpiSum = roomRows.reduce((s, r) => s + (r.revenueKpi ?? 0), 0);
      const revenueKpi = kpiSum > 0 ? kpiSum : null;
      return {
        propertyId: p.id, name: p.name, stats: statsOf(mine), prevOverall: statsOf(before.filter((r) => r.propertyId === p.id)).avg.overall,
        rooms: roomRows, revenue, revenueKpi, kpiPct: pct(revenue, revenueKpi), bookings: roomRows.reduce((s, r) => s + r.bookings, 0),
      };
    })
    .filter((p) => p.stats.count > 0 || p.prevOverall !== null || p.revenue > 0);

  const items: ReviewItem[] = cur
    .map((r) => ({
      id: r.id,
      propertyId: r.propertyId,
      propertyName: propName[r.propertyId] ?? "",
      roomName: r.roomId ? roomName[r.roomId] ?? null : null,
      listingName: r.listingName,
      guestName: r.guestName,
      reviewDate: r.reviewDate,
      checkIn: r.checkIn,
      checkOut: r.checkOut,
      overall: overallOf(r),
      scores: Object.fromEntries(SCORE_FIELDS.map((f) => [f, r[f]])) as Record<ScoreField, number | null>,
      content: r.content,
      low: isLowReview(overallOf(r)),
    }))
    .sort((a, b) => b.reviewDate.localeCompare(a.reviewDate));

  const inProgress = D.monthOf(today) === month;
  return {
    month,
    inProgress,
    asOf: inProgress ? today : D.lastDay(month),
    total: statsOf(cur),
    prevTotal: statsOf(before),
    byProperty,
    items,
  };
}

const fmt = (n: number | null) => (n === null ? "–" : n.toFixed(2).replace(".", ","));

/**
 * Gửi Lark bản tổng kết đánh giá tháng trước, một lần duy nhất, trong 3 ngày đầu tháng mới.
 * Dấu đã gửi là một cảnh báo REVIEW_DIGEST đóng sẵn (không hiện lên trang nào).
 */
export async function sendMonthlyReviewDigest(db: DB, today = D.todayVN()): Promise<boolean> {
  if (Number(today.slice(8, 10)) > 3) return false;
  const month = D.prevMonth(D.monthOf(today));
  const [mark] = await db
    .insert(alerts)
    .values({ type: "REVIEW_DIGEST", key: `REVIEW_DIGEST:${month}`, month, message: `Đã gửi tổng kết đánh giá ${D.formatMonthVN(month)}`, resolvedAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: alerts.id });
  if (!mark) return false;

  const props = await db.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.active, true)).orderBy(asc(properties.name));
  const rows = await reviewsInRange(db, props.map((p) => p.id), D.firstDay(month), D.lastDay(month));
  if (!rows.length) return false;
  const total = statsOf(rows);
  const lines = props
    .map((p) => ({ p, s: statsOf(rows.filter((r) => r.propertyId === p.id)) }))
    .filter((x) => x.s.count)
    .map(({ p, s }) => `• ${p.name}: ${s.count} đánh giá, TB ${fmt(s.avg.overall)}★, sạch sẽ ${fmt(s.avg.cleanliness)}${s.low ? `, ${s.low} đánh giá dưới 4★` : ""}`);
  await notifyLark(
    db,
    `LOCI – tổng kết đánh giá ${D.formatMonthVN(month).toLowerCase()}: ${total.count} đánh giá, điểm TB ${fmt(total.avg.overall)}★, ${total.fiveStar} đánh giá 5★, ${total.low} đánh giá dưới 4★.\n${lines.join("\n")}`,
  );
  return true;
}

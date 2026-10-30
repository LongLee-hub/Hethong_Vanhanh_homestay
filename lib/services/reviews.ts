// Tổng hợp đánh giá theo tháng (tháng khách trả phòng), theo từng cơ sở. Luôn lọc theo cơ sở người xem được phép.
import { asc, eq, inArray } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { alerts, properties, reviews, rooms } from "../db/schema";
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
}

const overallOf = (r: ReviewRow) => (Number(r.score) > 0 ? Number(r.score) : null);
const valueOf = (r: ReviewRow, c: Criterion) => (c === "overall" ? overallOf(r) : r[c]);

export function statsOf(rows: ReviewRow[]): ReviewStats {
  const avg = {} as Record<Criterion, number | null>;
  for (const c of CRITERIA) {
    const vs = rows.map((r) => valueOf(r, c)).filter((v): v is number => v !== null && v > 0);
    avg[c] = vs.length ? Math.round((vs.reduce((s, v) => s + v, 0) / vs.length) * 100) / 100 : null;
  }
  return { count: rows.length, avg, low: rows.filter((r) => isLowReview(overallOf(r))).length, fiveStar: rows.filter((r) => overallOf(r) === 5).length };
}

export interface ReviewItem {
  id: string;
  propertyId: string;
  propertyName: string;
  roomName: string | null;
  listingName: string | null;
  guestName: string | null;
  reviewDate: string;
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
  byProperty: { propertyId: string; name: string; stats: ReviewStats; prevOverall: number | null }[];
  items: ReviewItem[];
}

export async function monthlyReviewSummary(db: DB, user: SessionUser, month: string, today = D.todayVN()): Promise<MonthlyReviewSummary> {
  const ids = await allowedPropertyIds(db, user);
  const prev = D.prevMonth(month);
  const [cur, before, props, rs] = await Promise.all([
    reviewsInRange(db, ids, D.firstDay(month), D.lastDay(month)),
    reviewsInRange(db, ids, D.firstDay(prev), D.lastDay(prev)),
    ids.length ? db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, ids)).orderBy(asc(properties.name)) : [],
    ids.length ? db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(inArray(rooms.propertyId, ids)) : [],
  ]);
  const roomName = Object.fromEntries(rs.map((r) => [r.id, r.name]));
  const propName = Object.fromEntries(props.map((p) => [p.id, p.name]));

  const byProperty = props
    .map((p) => {
      const mine = cur.filter((r) => r.propertyId === p.id);
      return { propertyId: p.id, name: p.name, stats: statsOf(mine), prevOverall: statsOf(before.filter((r) => r.propertyId === p.id)).avg.overall };
    })
    .filter((p) => p.stats.count > 0 || p.prevOverall !== null);

  const items: ReviewItem[] = cur
    .map((r) => ({
      id: r.id,
      propertyId: r.propertyId,
      propertyName: propName[r.propertyId] ?? "",
      roomName: r.roomId ? roomName[r.roomId] ?? null : null,
      listingName: r.listingName,
      guestName: r.guestName,
      reviewDate: r.reviewDate,
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

// Đánh giá khách: map review Dayladau, đồng bộ (không trùng, gắn đúng phòng/cơ sở, báo đánh giá thấp mới),
// tổng hợp theo tháng trả phòng và chỉ cho xem cơ sở được phép, tổng kết đầu tháng gửi đúng một lần.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { mapDayladauReview, syncReviews, type RawReview } from "../lib/dayladau/reviews";
import { monthlyReviewSummary, sendMonthlyReviewDigest, statsOf } from "../lib/services/reviews";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };

const ts = (d: string) => Math.floor(new Date(`${d}T05:00:00Z`).getTime() / 1000); // Unix giây như API
const rv = (id: number, listing: string, overall: number, out: string, extra: Partial<RawReview> = {}): RawReview => ({
  id, overall, location: 5, accuracy: 5, checkin: 5, cleanliness: overall, communication: 5, comment: `review ${id}`,
  user: { fullname: `Khách ${id}`, phone: "0900000000" },
  reservation: { start_time: ts("2026-10-01"), end_time: ts(out) },
  listing: { id: listing, name: `Listing ${listing}` },
  ...extra,
});

let api: Record<string, RawReview[]> = {};
const fakeFetch = async (hostId: string) => api[hostId] ?? [];

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.users).values([
    { id: admin.id, name: admin.name, role: "ADMIN", passwordHash: "x" },
    { id: invA.id, name: invA.name, role: "INVESTOR", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([{ id: "inv-a", name: "NĐT A", userId: invA.id }, { id: "inv-b", name: "NĐT B" }]);
  await db.insert(s.dayladauAccounts).values([
    { id: "acc-a", investorId: "inv-a", label: "TK A", hostId: "HOST-A", tokenEncrypted: "tok-a" },
    { id: "acc-b", investorId: "inv-b", label: "TK B", hostId: "HOST-B", tokenEncrypted: "tok-b" },
  ]);
  await db.insert(s.properties).values([
    { id: "X", investorId: "inv-a", name: "Vạn Phúc", dayladauAccountId: "acc-a" },
    { id: "Y", investorId: "inv-a", name: "Phan Kế Bính", dayladauAccountId: "acc-a" },
    { id: "Z", investorId: "inv-b", name: "Nguyễn Tư Giản", dayladauAccountId: "acc-b" },
  ]);
  await db.insert(s.rooms).values([
    { id: "x1", propertyId: "X", name: "101", dayladauAccountId: "acc-a", dayladauRoomId: "L1", openedOn: "2026-01-01" },
    { id: "y1", propertyId: "Y", name: "201", dayladauAccountId: "acc-a", dayladauRoomId: "L2", openedOn: "2026-01-01" },
  ]);
});

describe("map review Dayladau", () => {
  it("lấy điểm, ngày trả phòng theo giờ VN, 0 là không chấm", () => {
    const m = mapDayladauReview(rv(7, "L1", 4.5, "2026-10-31", { checkin: 0 }));
    expect(m).toMatchObject({ externalId: "7", listingKey: "L1", overall: 4.5, reviewDate: "2026-10-31", guestName: "Khách 7", comment: "review 7" });
    expect(m.scores.checkin).toBeNull();
  });

  it("không có id thì báo lỗi", () => {
    expect(() => mapDayladauReview({ overall: 5 })).toThrow();
  });
});

describe("đồng bộ đánh giá", () => {
  it("ghi vào đúng phòng/cơ sở, bỏ qua listing chưa gắn khi tài khoản có nhiều cơ sở", async () => {
    api = {
      "HOST-A": [rv(1, "L1", 5, "2026-10-10"), rv(2, "L2", 3, "2026-10-20"), rv(3, "L9", 5, "2026-10-21")],
      // Tài khoản B chỉ dùng cho một cơ sở: listing chưa gắn phòng vẫn ghi vào cơ sở đó
      "HOST-B": [rv(4, "L7", 4.8, "2026-10-05"), rv(5, "L7", 5, "2026-09-28")],
    };
    const r = await syncReviews(db, { fetch: fakeFetch, decrypt: (x) => x, today: "2026-10-30" });
    expect(r).toMatchObject({ created: 4, updated: 0, skipped: 1, lowAlerts: 1 });
    expect(r.unmapped).toEqual([{ account: "NĐT A · TK A", listing: "Listing L9", count: 1 }]);
    const [two] = await db.select().from(schema.reviews).where(eq(schema.reviews.externalId, "2"));
    expect(two).toMatchObject({ propertyId: "Y", roomId: "y1", score: "3.00", cleanliness: 3 });
    const bad = await db.select().from(schema.alerts).where(eq(schema.alerts.type, "BAD_REVIEW"));
    expect(bad.map((a) => a.key)).toEqual(["BAD_REVIEW:2"]);
  });

  it("chạy lại không tạo trùng, cập nhật nội dung, không báo lại", async () => {
    api["HOST-A"][0] = rv(1, "L1", 5, "2026-10-10", { comment: "đã sửa" });
    const r = await syncReviews(db, { fetch: fakeFetch, decrypt: (x) => x, today: "2026-10-30" });
    expect(r).toMatchObject({ created: 0, updated: 4, lowAlerts: 0 });
    expect(await db.select().from(schema.reviews)).toHaveLength(4);
    const [one] = await db.select().from(schema.reviews).where(eq(schema.reviews.externalId, "1"));
    expect(one.content).toBe("đã sửa");
  });

  it("đánh giá thấp cũ (trả phòng quá 30 ngày) không báo", async () => {
    api["HOST-B"].push(rv(6, "L7", 2, "2026-08-01"));
    const r = await syncReviews(db, { fetch: fakeFetch, decrypt: (x) => x, today: "2026-10-30" });
    expect(r).toMatchObject({ created: 1, lowAlerts: 0 });
  });

  it("lỗi API của một tài khoản không chặn tài khoản khác", async () => {
    const r = await syncReviews(db, {
      decrypt: (x) => x, today: "2026-10-30",
      fetch: async (host) => { if (host === "HOST-A") throw new Error("HTTP 500"); return api[host] ?? []; },
    });
    expect(r.errors).toHaveLength(1);
    expect(r.updated).toBe(api["HOST-B"].length);
  });
});

describe("tổng hợp tháng", () => {
  it("điểm trung bình bỏ qua tiêu chí không chấm", () => {
    const rows = [{ score: "5", cleanliness: 4 }, { score: "4", cleanliness: null }] as unknown as Parameters<typeof statsOf>[0];
    expect(statsOf(rows).avg).toMatchObject({ overall: 4.5, cleanliness: 4 });
  });

  it("Admin thấy mọi cơ sở, tháng đang chạy tính đến hôm nay", async () => {
    const s = await monthlyReviewSummary(db, admin, "2026-10", "2026-10-30");
    expect(s).toMatchObject({ inProgress: true, asOf: "2026-10-30" });
    expect(s.total).toMatchObject({ count: 3, low: 1, fiveStar: 1 });
    expect(s.total.avg.overall).toBe(4.27);
    expect(s.byProperty.map((p) => p.name)).toEqual(["Nguyễn Tư Giản", "Phan Kế Bính", "Vạn Phúc"]);
    // Tháng trước của cơ sở Z có 1 đánh giá 5★
    expect(s.byProperty.find((p) => p.propertyId === "Z")?.prevOverall).toBe(5);
  });

  it("NĐT chỉ thấy đánh giá cơ sở của mình", async () => {
    const s = await monthlyReviewSummary(db, invA, "2026-10", "2026-10-30");
    expect(new Set(s.items.map((i) => i.propertyId))).toEqual(new Set(["X", "Y"]));
    expect(s.items.find((i) => i.propertyId === "Y")).toMatchObject({ roomName: "201", low: true });
  });

  it("tháng đã qua thì tính đến ngày cuối tháng", async () => {
    const s = await monthlyReviewSummary(db, admin, "2026-09", "2026-10-30");
    expect(s).toMatchObject({ inProgress: false, asOf: "2026-09-30" });
  });
});

describe("tổng kết đầu tháng", () => {
  it("chỉ gửi trong 3 ngày đầu tháng và chỉ một lần", async () => {
    expect(await sendMonthlyReviewDigest(db, "2026-11-05")).toBe(false);
    expect(await sendMonthlyReviewDigest(db, "2026-11-01")).toBe(true);
    expect(await sendMonthlyReviewDigest(db, "2026-11-02")).toBe(false);
  });
});

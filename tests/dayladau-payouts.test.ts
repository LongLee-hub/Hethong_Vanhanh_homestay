// Phiếu thanh toán Dayladau: đồng bộ với API giả lập, đối chiếu từng đơn với đơn trong hệ thống, phân quyền giữa các NĐT.
// Dữ liệu mẫu theo đúng cấu trúc API thật (phiếu 16783, đơn 309739 ngày 24/10/2026). Chạy trên PGlite với migration thật.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { asBookingOrder, refreshBookingsFromOrders } from "../lib/dayladau/order-refresh";
import { dayladauPayoutsForMonth, mapPayoutOrder, matchLine, payoutAmountOf, payoutsUrl, rematchDayladauPayoutItems, syncDayladauPayouts, type DayladauPayoutApi } from "../lib/dayladau/payouts";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const invB: SessionUser = { id: "u-inv-b", name: "NĐT B", role: "INVESTOR" };

// 24/10/2026 12:00 và 16:00 giờ VN
const T = (iso: string) => Date.parse(iso);
function order(id: number, opts: { amount: number; total: number; nickname?: string; status?: string; payout?: number; hostItems?: number[] }) {
  return {
    id, total: opts.total, total_billed: opts.total, status: "paid",
    listing: { id: `lst-${opts.nickname ?? "VP202"}`, name: `Unix ${opts.nickname ?? "VP202"}/Bồn tắm`, nickname: opts.nickname ?? "VP202" },
    guest: { fullname: `Khách ${id}` },
    reservation: { start_time: T("2026-10-24T12:00:00+07:00"), end_time: T("2026-10-24T16:00:00+07:00"), status: opts.status ?? "completed", source: "app_ios" },
    items: (opts.hostItems ?? [opts.amount]).map((h, i) => ({ id: i, type: "reservation", amount: h * 1.25, host_amount: h, commission_rates: [{ type: "host", rate: 0.8 }] })),
    payout_id: opts.payout ?? 0,
    payout_amount: opts.payout ? opts.amount : 0,
  };
}

const PAID = [
  order(309739, { amount: 253600, total: 285300, payout: 16783 }),
  order(309695, { amount: 253600, total: 287000, nickname: "VP302", payout: 16783 }),
  // Mã giảm giá do Dayladau chịu: host nhận nhiều hơn khách trả
  order(306922, { amount: 257040, total: 224910, nickname: "LT-501", payout: 16783 }),
  // Đơn đã hủy vẫn được trả phí hủy
  order(308882, { amount: 159200, total: 189050, nickname: "LT-101", status: "cancelled", payout: 16783 }),
];
const UNPAID = [order(310001, { amount: 300000, total: 375000, nickname: "PKB206", hostItems: [320000, -20000] })];
const PAYOUT = {
  id: 16783, order_ids: "309739,309695,306922,308882", host_id: "host-a",
  amount: 253600 + 253600 + 257040 + 159200, status: "confirmed",
  created_at: T("2026-10-26T09:41:37+07:00"), confirmed_at: T("2026-10-27T11:00:00+07:00"),
  picture_url: "https://r2.dayladau-cdn.com/file/abc", transfer_ref: "", note: "",
};

function fakeApi() {
  const calls: string[] = [];
  const api: DayladauPayoutApi = {
    async listPayouts(hostId, token, fromMs, toMs) {
      calls.push(`payouts:${hostId}:${token}`);
      if (hostId !== "host-a") return [];
      return [PAYOUT].filter((p) => p.created_at >= fromMs && p.created_at <= toMs);
    },
    async listOrders(hostId, _t, status, offset) {
      calls.push(`orders:${hostId}:${status}:${offset}`);
      if (hostId !== "host-a" || offset > 0) return [];
      return status === "paid" ? PAID : UNPAID;
    },
  };
  return { api, calls };
}

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
    { id: invB.id, name: invB.name, role: "INVESTOR", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([{ id: "inv-a", name: "Unixstay", userId: invA.id }, { id: "inv-b", name: "NĐT B", userId: invB.id }]);
  await db.insert(s.dayladauAccounts).values([
    { id: "acc-a", investorId: "inv-a", label: "TK Unix", hostId: "host-a", tokenEncrypted: "tok-a" },
    { id: "acc-b", investorId: "inv-b", label: "TK B", hostId: "host-b", tokenEncrypted: "tok-b" },
  ]);
  await db.insert(s.properties).values([{ id: "VP", investorId: "inv-a", name: "Vạn Phúc", dayladauAccountId: "acc-a" }, { id: "Z", investorId: "inv-b", name: "NTG", dayladauAccountId: "acc-b" }]);
  await db.insert(s.rooms).values([{ id: "VP202", propertyId: "VP", name: "202", openedOn: "2026-01-01" }, { id: "Z1", propertyId: "Z", name: "101", openedOn: "2026-01-01" }]);
  const bk = (externalId: string, net: number) => ({
    source: "DAYLADAU" as const, externalId, propertyId: "VP", roomId: "VP202", channel: "Dayladau", checkIn: "2026-10-24", checkOut: "2026-10-25",
    grossAmount: net, netAmount: net, status: "CONFIRMED" as const,
  });
  // 309739 khớp, 309695 lệch tiền, 306922 khớp, 308882 chưa có trong hệ thống
  await db.insert(s.bookings).values([bk("309739", 253600), bk("309695", 250000), bk("306922", 257040)]);
});

describe("map đơn và tiền thanh toán", () => {
  it("dùng payout_amount, không có thì cộng host_amount", () => {
    expect(payoutAmountOf(PAID[0])).toBe(253600);
    expect(payoutAmountOf(UNPAID[0])).toBe(300000);
    const m = mapPayoutOrder(PAID[3]);
    expect(m).toMatchObject({ orderId: "308882", listingName: "LT-101", checkIn: "2026-10-24", orderStatus: "cancelled", source: "app_ios", grossAmount: 189050, amount: 159200 });
  });

  it("so tiền với đơn trong hệ thống", () => {
    expect(matchLine(253600, { netAmount: 253600 })).toEqual({ status: "MATCHED", diff: 0 });
    expect(matchLine(253600, { netAmount: 250000 })).toEqual({ status: "AMOUNT_DIFF", diff: 3600 });
    expect(matchLine(253600, undefined)).toEqual({ status: "NOT_FOUND", diff: null });
  });

  it("URL phiếu dùng mili-giây và token", () => {
    const u = new URL(payoutsUrl("host-a", "tok", 1, 2));
    expect(u.pathname).toBe("/v1/payouts");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ host_id: "host-a", start_time: "1", end_time: "2", x_access_token: "tok" });
  });
});

describe("đồng bộ phiếu thanh toán", () => {
  it("lưu phiếu, từng đơn và đơn chờ trả; đối chiếu với đơn trong hệ thống", async () => {
    const { api, calls } = fakeApi();
    const sum = await syncDayladauPayouts(db, { api, decrypt: (s) => s, today: "2026-10-31" });
    expect(sum.errors).toEqual([]);
    // 309695 lệch tiền trong hệ thống được cập nhật theo bản mới nhất của đơn trước khi đối chiếu
    expect(sum).toMatchObject({ accounts: 2, payouts: 1, orders: 4, matched: 3, amountDiff: 0, notFound: 1, totalMismatch: 0, pending: 1, bookingsCreated: 0 });
    expect(sum.bookingsUpdated).toBeGreaterThanOrEqual(1);
    expect(calls).toContain("payouts:host-a:tok-a");

    const [p] = await db.select().from(schema.dayladauPayouts);
    expect(p).toMatchObject({ externalId: "16783", payoutDate: "2026-10-26", amount: 923440, itemsTotal: 923440, orderCount: 4, status: "confirmed", investorId: "inv-a" });

    const items = await db.select().from(schema.dayladauPayoutItems).where(eq(schema.dayladauPayoutItems.payoutId, p.id));
    const by = Object.fromEntries(items.map((i) => [i.orderId, i]));
    expect(by["309695"]).toMatchObject({ matchStatus: "MATCHED", diffAmount: 0, bookingNet: 253600 });
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "309695"));
    expect(b).toMatchObject({ netAmount: 253600, grossAmount: 287000, channel: "Dayladau", status: "CONFIRMED" });
    expect(by["308882"]).toMatchObject({ matchStatus: "NOT_FOUND", bookingId: null });
    expect(by["306922"]).toMatchObject({ matchStatus: "MATCHED", grossAmount: 224910, amount: 257040 });
  });

  it("đồng bộ lại không nhân đôi phiếu hay đơn chờ trả", async () => {
    const { api } = fakeApi();
    await syncDayladauPayouts(db, { api, decrypt: (s) => s, today: "2026-10-31" });
    expect(await db.select().from(schema.dayladauPayouts)).toHaveLength(1);
    expect(await db.select().from(schema.dayladauPayoutItems)).toHaveLength(5);
  });

  it("đối chiếu lại khi đơn trong hệ thống thay đổi", async () => {
    await db.update(schema.bookings).set({ netAmount: 250000 }).where(eq(schema.bookings.externalId, "309695"));
    expect(await rematchDayladauPayoutItems(db, ["acc-a"])).toBe(1);
    const [it] = await db.select().from(schema.dayladauPayoutItems).where(eq(schema.dayladauPayoutItems.orderId, "309695"));
    expect(it).toMatchObject({ matchStatus: "AMOUNT_DIFF", diffAmount: 3600 });
  });

  it("lỗi một tài khoản không dừng tài khoản khác, không lộ token", async () => {
    const { api } = fakeApi();
    const broken: DayladauPayoutApi = { ...api, async listPayouts(h, t, f, to) { if (h === "host-b") throw new Error("Host ID hoặc access token không hợp lệ (HTTP 401)"); return api.listPayouts(h, t, f, to); } };
    const sum = await syncDayladauPayouts(db, { api: broken, decrypt: (s) => s, today: "2026-10-31" });
    expect(sum.payouts).toBe(1);
    expect(sum.errors).toEqual([{ accountId: "acc-b", investorId: "inv-b", message: "Host ID hoặc access token không hợp lệ (HTTP 401)" }]);
  });
});

describe("trang đối chiếu", () => {
  it("NĐT chỉ thấy phiếu của mình; dòng lệch lên đầu", async () => {
    const a = await dayladauPayoutsForMonth(db, invA, "2026-10");
    expect(a.payouts).toHaveLength(1);
    expect(a.payouts[0].lines[0]).toMatchObject({ orderId: "308882", matchStatus: "NOT_FOUND" });
    expect(a.payouts[0].lines.find((l) => l.orderId === "309739")).toMatchObject({ roomId: "VP202" });
    expect(a.pending).toHaveLength(1);
    expect(a.pending[0]).toMatchObject({ orderId: "310001", accountLabel: "TK Unix" });

    const b = await dayladauPayoutsForMonth(db, invB, "2026-10");
    expect(b.payouts).toHaveLength(0);
    expect(b.pending).toHaveLength(0);
    expect(b.accounts.map((x) => x.id)).toEqual(["acc-b"]);
  });

  it("lọc theo host ID", async () => {
    const all = await dayladauPayoutsForMonth(db, admin, "2026-10");
    expect(all.accounts.map((x) => x.hostId).sort()).toEqual(["host-a", "host-b"]);
    const a = await dayladauPayoutsForMonth(db, admin, "2026-10", "host-a");
    expect(a.payouts.map((p) => p.hostId)).toEqual(["host-a"]);
    expect(a.pending.every((l) => l.hostId === "host-a")).toBe(true);
    const b = await dayladauPayoutsForMonth(db, admin, "2026-10", "host-b");
    expect(b.payouts).toHaveLength(0);
    expect(b.pending).toHaveLength(0);
    expect(b.accounts).toHaveLength(2); // bộ lọc vẫn đủ lựa chọn
    // NĐT không lọc được sang host của người khác
    expect((await dayladauPayoutsForMonth(db, invB, "2026-10", "host-a")).payouts).toHaveLength(0);
  });

  it("lọc theo tháng tạo phiếu", async () => {
    expect((await dayladauPayoutsForMonth(db, admin, "2026-09")).payouts).toHaveLength(0);
    expect((await dayladauPayoutsForMonth(db, admin, "2026-10")).payouts).toHaveLength(1);
  });
});

describe("cập nhật đơn trong hệ thống theo đơn trong phiếu", () => {
  // Đơn #302670 thật: đặt 12/10, gia hạn 22/10 làm giá đặt chỗ tăng 898.000 → 1.058.000; mã giảm giá do Dayladau chịu
  const extended = {
    id: 302670, total_billed: 1004120, status: "paid",
    listing: { id: "lst-VP202", name: "Unix VP202/Bồn tắm", nickname: "VP202" },
    guest: { fullname: "Như Quỳnh" },
    reservation: { start_time: T("2026-10-20T14:00:00+07:00"), end_time: T("2026-10-22T13:00:00+07:00"), status: "completed", source: "app_ios" },
    items: [{ id: 1, type: "reservation", amount: 1058000, host_amount: 846400, commission_rates: [{ type: "host", rate: 0.8 }] }],
    payout_id: 16783, payout_amount: 846400,
  };

  it("trạng thái đặt phòng lấy từ reservation.status, không phải trạng thái thanh toán", () => {
    expect(asBookingOrder(PAID[3]).status).toBe("cancelled");
    expect(asBookingOrder({ id: 1, status: "cancelled" }).status).toBe("cancelled");
  });

  it("đơn gia hạn sau khi đã đồng bộ: cập nhật tiền và ngày, giữ kênh và loại thuê", async () => {
    await db.insert(schema.bookings).values({
      source: "DAYLADAU", externalId: "302670", propertyId: "VP", roomId: "VP202", channel: "Airbnb", rentalType: "overnight",
      checkIn: "2026-10-20", checkOut: "2026-10-21", grossAmount: 898000, commissionAmount: 179600, netAmount: 718400, status: "CONFIRMED", rawPayload: { v: 1 },
    });
    const r = await refreshBookingsFromOrders(db, "acc-a", [extended]);
    expect(r).toMatchObject({ updated: 1, skipped: 0 });
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "302670"));
    expect(b).toMatchObject({ netAmount: 846400, grossAmount: 1004120, checkOut: "2026-10-22", channel: "Airbnb", rentalType: "overnight", rawPayload: { v: 1 } });
    const nights = await db.select().from(schema.bookingNights).where(eq(schema.bookingNights.bookingId, b.id));
    expect(nights.reduce((s, n) => s + n.netAmount, 0)).toBe(846400);
    // Chạy lại không đổi gì
    expect(await refreshBookingsFromOrders(db, "acc-a", [extended])).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it("tiền tính ra khác tiền Dayladau trả thì không ghi", async () => {
    const odd = { ...extended, payout_amount: 900000 };
    expect(await refreshBookingsFromOrders(db, "acc-a", [odd])).toMatchObject({ skipped: 1, updated: 0 });
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "302670"));
    expect(b.netAmount).toBe(846400);
  });

  it("đơn bị sót của listing đã gắn phòng được tạo mới; listing chưa gắn thì bỏ qua", async () => {
    expect(await refreshBookingsFromOrders(db, "acc-a", [PAID[3]])).toMatchObject({ created: 0, skipped: 1 });
    await db.insert(schema.rooms).values({ id: "LT101", propertyId: "VP", name: "LT-101", openedOn: "2026-10-30", dayladauAccountId: "acc-a", dayladauRoomId: "lst-LT-101" });
    expect(await refreshBookingsFromOrders(db, "acc-a", [PAID[3]])).toMatchObject({ created: 1 });
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "308882"));
    expect(b).toMatchObject({ roomId: "LT101", status: "CANCELLED", netAmount: 159200 });
    // Tài khoản khác không ghi được vào phòng của tài khoản này
    expect(await refreshBookingsFromOrders(db, "acc-b", [{ ...PAID[3], id: 999 }])).toMatchObject({ created: 0, skipped: 1 });
  });
});

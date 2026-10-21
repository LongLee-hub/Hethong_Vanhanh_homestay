// Payout Airbnb từ Gmail: đồng bộ với Gmail giả lập, đối soát với đơn, phân quyền giữa các NĐT. Chạy trên PGlite với migration thật.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import type { GmailClient, GmailMessage } from "../lib/gmail/client";
import { disconnectGmail, listGmailAccounts, payoutsForMonth, reparsePayout, saveGmailConnection, syncPayouts } from "../lib/airbnb/payouts";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const invB: SessionUser = { id: "u-inv-b", name: "NĐT B", role: "INVESTOR" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };
const plain = (s: string) => s; // test không mã hóa token

const mail = (id: string, subject: string, lines: string[], at = "2026-10-06T03:00:00Z"): GmailMessage => ({ id, receivedAt: new Date(at), from: "Airbnb <express@airbnb.com>", subject, text: lines.join("\n") });

function fakeGmail(messages: GmailMessage[]) {
  const calls: { query: string }[] = [];
  const client: GmailClient = {
    async listMessageIds(token, query) {
      expect(token).toBe("access-for-refresh-a");
      calls.push({ query });
      return messages.map((m) => m.id);
    },
    async getMessage(_t, id) {
      return messages.find((m) => m.id === id)!;
    },
  };
  return { client, calls };
}
const token = async (r: string) => `access-for-${r}`;

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
    { id: acc.id, name: acc.name, role: "ACCOUNTANT", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([{ id: "inv-a", name: "NĐT A", userId: invA.id }, { id: "inv-b", name: "NĐT B", userId: invB.id }]);
  await db.insert(s.properties).values([{ id: "X", investorId: "inv-a", name: "Vạn Phúc" }, { id: "Z", investorId: "inv-b", name: "Nguyễn Tư Giản" }]);
  await db.insert(s.rooms).values([{ id: "X1", propertyId: "X", name: "P101", openedOn: "2026-01-01" }, { id: "Z1", propertyId: "Z", name: "P101", openedOn: "2026-01-01" }]);
  await db.insert(s.userPropertyAccess).values([{ userId: acc.id, propertyId: "X" }]);
  const bk = (id: string, propertyId: string, roomId: string, guestName: string, checkIn: string, checkOut: string, netAmount: number, raw: object | null) => ({
    id, source: "DAYLADAU" as const, externalId: `DL-${id}`, propertyId, roomId, channel: "Airbnb", guestName, checkIn, checkOut, netAmount, grossAmount: netAmount, status: "CONFIRMED" as const, rawPayload: raw,
  });
  await db.insert(s.bookings).values([
    // Mã HM nằm trong dữ liệu gốc Dayladau
    bk("b1", "X", "X1", "Nguyen Van An", "2026-10-03", "2026-10-05", 1_950_000, { ota_reservation_code: "HMABCD1234" }),
    // Không có mã HM: khớp dự phòng bằng tên khách + ngày nhận phòng; hệ thống ghi thiếu 100.000
    bk("b2", "X", "X1", "John Smith", "2026-10-05", "2026-10-07", 1_400_000, null),
    // Đơn Airbnb đã nhận phòng mà chưa có payout
    bk("b3", "X", "X1", "Le Thi C", "2026-10-10", "2026-10-11", 800_000, null),
    // Cùng mã HM nhưng thuộc NĐT B: không được khớp vào payout của NĐT A
    bk("b4", "Z", "Z1", "Nguyen Van An", "2026-10-03", "2026-10-05", 1_950_000, { ota_reservation_code: "HMABCD1234" }),
  ]);
});

const PAYOUT = mail("m1", "We sent you a payout of ₫3,450,000 VND", [
  "We sent a payout of ₫3,450,000 VND to your account ••••1234.",
  "Nguyen Van An", "Oct 3 – 5, 2026", "HMABCD1234", "₫1,950,000 VND",
  "John Smith", "Oct 5 – 7, 2026", "HMNOCODE01", "₫1,500,000 VND",
]);

describe("Kết nối Gmail", () => {
  it("NĐT chỉ kết nối Gmail cho chính mình; kế toán không kết nối được", async () => {
    await expect(saveGmailConnection(db, invB, { investorId: "inv-a", email: "a@gmail.com", refreshToken: "refresh-a" }, plain)).rejects.toThrow(/Không tìm thấy/);
    await expect(saveGmailConnection(db, acc, { investorId: "inv-a", email: "a@gmail.com", refreshToken: "refresh-a" }, plain)).rejects.toThrow(/Không tìm thấy/);
    const row = await saveGmailConnection(db, invA, { investorId: "inv-a", email: "A@Gmail.com", refreshToken: "refresh-a" }, plain);
    expect(row.email).toBe("a@gmail.com");
  });

  it("một Gmail không gắn được cho hai NĐT", async () => {
    await expect(saveGmailConnection(db, admin, { investorId: "inv-b", email: "a@gmail.com", refreshToken: "x" }, plain)).rejects.toThrow(/nhà đầu tư khác/);
  });

  it("danh sách Gmail không lộ token và lọc theo NĐT", async () => {
    const forA = await listGmailAccounts(db, invA);
    expect(forA.map((a) => a.email)).toEqual(["a@gmail.com"]);
    expect(JSON.stringify(forA)).not.toContain("refresh-a");
    expect(await listGmailAccounts(db, invB)).toEqual([]);
    expect((await listGmailAccounts(db, acc))[0].canManage).toBe(false);
  });
});

describe("Đồng bộ và đối soát payout", () => {
  it("đọc email payout, bỏ qua thư khác, khớp đơn theo mã HM và theo tên khách + ngày", async () => {
    const other = mail("m2", "Reservation confirmed - An arrives Oct 3", ["HMABCD1234"]);
    const { client, calls } = fakeGmail([PAYOUT, other]);
    const sum = await syncPayouts(db, { client, accessToken: token, decrypt: plain, today: "2026-10-21" });
    expect(sum).toMatchObject({ accounts: 1, messages: 2, created: 1, skipped: 1, matched: 2, errors: [] });
    expect(calls[0].query).toContain("after:2026/04/24"); // lần đầu đọc lùi 180 ngày

    const { payouts } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    expect(payouts).toHaveLength(1);
    const [p] = payouts;
    expect(p.amount).toBe(3_450_000);
    expect(p.items.map((i) => [i.confirmationCode, i.booking?.id, i.matchStatus, i.diffAmount])).toEqual([
      ["HMABCD1234", "b1", "MATCHED", 0],
      ["HMNOCODE01", "b2", "AMOUNT_DIFF", 100_000],
    ]);
  });

  it("đồng bộ lại không tạo trùng; lần sau chỉ đọc lùi 7 ngày", async () => {
    const { client, calls } = fakeGmail([PAYOUT]);
    const sum = await syncPayouts(db, { client, accessToken: token, decrypt: plain, today: "2026-10-22" });
    expect(sum.created).toBe(0);
    expect(calls[0].query).toMatch(/after:2026\/10\/1[45]/);
  });

  it("liệt kê đơn Airbnb đã nhận phòng quá 3 ngày mà chưa có payout", async () => {
    const { missing } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    expect(missing.map((m) => m.bookingId)).toEqual(["b3"]);
    // Chưa quá 3 ngày thì chưa báo
    expect((await payoutsForMonth(db, invA, "2026-10", "2026-10-12")).missing).toEqual([]);
  });

  it("NĐT B không thấy payout của NĐT A; kế toán thấy theo cơ sở được giao", async () => {
    expect((await payoutsForMonth(db, invB, "2026-10", "2026-10-21")).payouts).toEqual([]);
    const forAcc = await payoutsForMonth(db, acc, "2026-10", "2026-10-21");
    expect(forAcc.payouts).toHaveLength(1);
    expect(forAcc.payouts[0].canManage).toBe(false);
  });

  it("đơn đồng bộ sau email payout được khớp ở lần đối soát kế tiếp; tách lại giữ đúng kết quả", async () => {
    await db.update(schema.bookings).set({ netAmount: 1_500_000 }).where(eq(schema.bookings.id, "b2"));
    const [p] = await db.select().from(schema.airbnbPayouts);
    await expect(reparsePayout(db, invB, p.id)).rejects.toThrow(/Không tìm thấy/);
    await reparsePayout(db, invA, p.id);
    const { payouts } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    expect(payouts[0].items.every((i) => i.matchStatus === "MATCHED")).toBe(true);
  });

  it("Gmail lỗi (thu hồi quyền) ghi trạng thái lỗi, không làm hỏng lượt đồng bộ", async () => {
    const sum = await syncPayouts(db, { client: fakeGmail([]).client, accessToken: async () => { throw new Error("Google từ chối quyền truy cập (invalid_grant) — cần kết nối lại Gmail"); }, decrypt: plain });
    expect(sum.errors[0].message).toMatch(/invalid_grant/);
    const [a] = await listGmailAccounts(db, invA);
    expect(a.lastSyncStatus).toBe("FAILED");
  });

  it("ngắt kết nối xóa token, giữ payout đã đọc", async () => {
    const [a] = await listGmailAccounts(db, invA);
    await expect(disconnectGmail(db, invB, a.id)).rejects.toThrow(/Không tìm thấy/);
    await disconnectGmail(db, invA, a.id);
    const [row] = await db.select().from(schema.gmailAccounts).where(eq(schema.gmailAccounts.id, a.id));
    expect(row).toMatchObject({ active: false, refreshTokenEncrypted: "" });
    expect((await payoutsForMonth(db, invA, "2026-10", "2026-10-21")).payouts).toHaveLength(1);
  });
});

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
import { deletePastedPayout, disconnectGmail, importPastedPayout, listGmailAccounts, payoutRevenueByMonth, payoutsForMonth, reparsePayout, saveGmailConnection, syncPayouts } from "../lib/airbnb/payouts";
import { SAMPLE_PASTE, SAMPLE_VI } from "./fixtures/payout-emails";
import { googleReady, googleSetup, loadGoogleConfig, saveGoogleSetup } from "../lib/gmail/config";
import { redirectUri } from "../lib/gmail/oauth";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const invB: SessionUser = { id: "u-inv-b", name: "NĐT B", role: "INVESTOR" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };
const plain = (s: string) => s; // test không mã hóa token

const mail = (id: string, subject: string, lines: string[], at = "2026-10-06T03:00:00Z"): GmailMessage => ({ id, receivedAt: new Date(at), from: "Airbnb <automated@airbnb.com>", subject, text: lines.join("\n") });

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
    // Mã đặt phòng Airbnb nằm trong dữ liệu gốc Dayladau; email: tiền phòng 1.980.948 ₫ − thuế 148.571 ₫ = 1.832.377 ₫
    bk("b1", "X", "X1", "Nguyen Van An", "2026-10-03", "2026-10-05", 1_832_000, { ota_reservation_code: "HMABCD1234" }),
    // Không có mã: khớp dự phòng bằng tên khách + ngày nhận phòng; hệ thống ghi thiếu (email 502.665 ₫)
    bk("b2", "X", "X1", "John Smith", "2026-10-30", "2026-11-02", 400_000, null),
    // Đơn Airbnb đã nhận phòng mà chưa có payout
    bk("b3", "X", "X1", "Le Thi C", "2026-10-10", "2026-10-11", 800_000, null),
    // Cùng mã nhưng thuộc NĐT B: không được khớp vào payout của NĐT A
    bk("b4", "Z", "Z1", "Nguyen Van An", "2026-10-03", "2026-10-05", 1_980_000, { ota_reservation_code: "HMABCD1234" }),
  ]);
});

const PAYOUT = mail("m1", "Chúng tôi đã gửi cho bạn một khoản chi trả", SAMPLE_VI.split("\n"));

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
  it("đọc email payout, bỏ qua thư khác, gộp dòng theo đơn, so tiền sau thuế với thực nhận", async () => {
    const other = mail("m2", "Đặt phòng đã được xác nhận", ["HMABCD1234  $80,00 USD"]);
    const { client, calls } = fakeGmail([PAYOUT, other]);
    const sum = await syncPayouts(db, { client, accessToken: token, decrypt: plain, today: "2026-10-21" });
    expect(sum).toMatchObject({ accounts: 1, messages: 2, created: 1, skipped: 1, duplicates: 0, matched: 2, errors: [] });
    expect(calls[0].query).toContain("from:automated@airbnb.com");
    expect(calls[0].query).toContain("after:2026/04/24"); // lần đầu đọc lùi 180 ngày

    const { payouts } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    expect(payouts).toHaveLength(1);
    const [p] = payouts;
    expect(p).toMatchObject({ amount: 2_335_042, payoutCode: "ABCDEF123456", totalUsd: 94.3 });
    expect(p.groups.map((g) => [g.confirmationCode, g.booking?.id, g.lines.map((l) => l.lineType), g.preTaxVnd, g.taxVnd, g.matchStatus, g.diffAmount])).toEqual([
      ["HMABCD1234", "b1", ["Tiền phòng", "Thuế TNCN", "Thuế VAT"], 1_980_948, -148_571, "MATCHED", 377],
      ["HMXYZ98765", "b2", ["Tiền phòng"], 502_665, 0, "AMOUNT_DIFF", 102_665],
    ]);
  });

  it("đồng bộ lại không tạo trùng; email gửi lặp cùng mã khoản chi trả bị bỏ qua; lần sau chỉ đọc lùi 7 ngày", async () => {
    const resent = mail("m3", "Chúng tôi đã gửi cho bạn một khoản chi trả", SAMPLE_VI.split("\n"), "2026-10-07T03:00:00Z");
    const { client, calls } = fakeGmail([PAYOUT, resent]);
    const sum = await syncPayouts(db, { client, accessToken: token, decrypt: plain, today: "2026-10-22" });
    expect(sum).toMatchObject({ created: 0, duplicates: 1 });
    expect(calls[0].query).toMatch(/after:2026\/10\/1[45]/);
  });

  it("liệt kê đơn Airbnb đã nhận phòng quá 3 ngày mà chưa có payout", async () => {
    const { missing } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    expect(missing.map((m) => m.bookingId)).toEqual(["b3"]);
    // Chưa quá 3 ngày thì chưa báo
    expect((await payoutsForMonth(db, invA, "2026-10", "2026-10-12")).missing).toEqual([]);
  });

  it("so với tiền trước thuế thì lệch đúng bằng thuế → báo lệch", async () => {
    await db.update(schema.bookings).set({ netAmount: 1_980_948 }).where(eq(schema.bookings.id, "b1"));
    const [p] = await db.select().from(schema.airbnbPayouts);
    await reparsePayout(db, invA, p.id);
    const g = (await payoutsForMonth(db, invA, "2026-10", "2026-10-21")).payouts[0].groups[0];
    expect([g.matchStatus, g.diffAmount]).toEqual(["AMOUNT_DIFF", -148_571]);
    await db.update(schema.bookings).set({ netAmount: 1_832_000 }).where(eq(schema.bookings.id, "b1"));
    await reparsePayout(db, invA, p.id);
  });

  it("doanh thu theo tháng ở: đơn trải tháng chia theo đêm, phần cuối nhận phần dư", async () => {
    const oct = await payoutRevenueByMonth(db, invA, "2026-10");
    expect(oct.map((r) => [r.confirmationCode, r.nights, r.totalNights, r.preTaxVnd, r.taxVnd, r.vnd])).toEqual([
      ["HMABCD1234", 2, 2, 1_980_948, -148_571, 1_832_377],
      ["HMXYZ98765", 2, 3, 335_110, 0, 335_110],
    ]);
    const nov = await payoutRevenueByMonth(db, invA, "2026-11");
    expect(nov.map((r) => [r.confirmationCode, r.partCheckIn, r.partCheckOut, r.vnd])).toEqual([["HMXYZ98765", "2026-11-01", "2026-11-02", 167_555]]);
    expect(oct[0].nickname).toBe("NTG402");
    expect(await payoutRevenueByMonth(db, invB, "2026-10")).toEqual([]);
  });

  it("NĐT B không thấy payout của NĐT A; kế toán thấy theo cơ sở được giao", async () => {
    expect((await payoutsForMonth(db, invB, "2026-10", "2026-10-21")).payouts).toEqual([]);
    const forAcc = await payoutsForMonth(db, acc, "2026-10", "2026-10-21");
    expect(forAcc.payouts).toHaveLength(1);
    expect(forAcc.payouts[0].canManage).toBe(false);
  });

  it("sửa thực nhận rồi tách lại: đơn chuyển sang khớp", async () => {
    await db.update(schema.bookings).set({ netAmount: 502_000 }).where(eq(schema.bookings.id, "b2"));
    const [p] = await db.select().from(schema.airbnbPayouts);
    await expect(reparsePayout(db, invB, p.id)).rejects.toThrow(/Không tìm thấy/);
    await reparsePayout(db, invA, p.id);
    const { payouts } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    expect(payouts[0].groups.map((g) => g.matchStatus)).toEqual(["MATCHED", "MATCHED"]);
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

describe("Cài đặt Google trên web", () => {
  const enc = (v: string) => `enc(${v})`;
  const dec = (v: string) => v.replace(/^enc\((.*)\)$/, "$1");
  const CID = "123-abc.apps.googleusercontent.com";

  it("chỉ Admin lưu được; kiểm tra định dạng trước khi ghi", async () => {
    await expect(saveGoogleSetup(db, invA, { clientId: CID, clientSecret: "GOCSPX-secret123", appUrl: "" }, enc)).rejects.toThrow(/quyền/);
    await expect(saveGoogleSetup(db, admin, { clientId: "abc", clientSecret: "GOCSPX-secret123", appUrl: "" }, enc)).rejects.toThrow(/Client ID/);
    await expect(saveGoogleSetup(db, admin, { clientId: CID, clientSecret: "", appUrl: "" }, enc)).rejects.toThrow(/Client Secret/);
    await expect(saveGoogleSetup(db, admin, { clientId: CID, clientSecret: "GOCSPX-secret123", appUrl: "https://app.loci.vn/payouts" }, enc)).rejects.toThrow(/địa chỉ gốc/);
    expect(googleReady(await loadGoogleConfig(db, dec))).toBe(false); // lỗi không lưu dở
  });

  it("lưu mã hóa secret, không trả secret ra ngoài; để trống secret thì giữ nguyên", async () => {
    await saveGoogleSetup(db, admin, { clientId: CID, clientSecret: "GOCSPX-secret123", appUrl: "https://app.loci.vn/" }, enc);
    const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, "google.clientSecret"));
    expect(row.value).toBe("enc(GOCSPX-secret123)");
    await saveGoogleSetup(db, admin, { clientId: CID, clientSecret: "", appUrl: "https://app.loci.vn" }, enc);
    const cfg = await loadGoogleConfig(db, dec);
    expect(cfg).toMatchObject({ clientId: CID, clientSecret: "GOCSPX-secret123", appUrl: "https://app.loci.vn" });
    expect(redirectUri(cfg, "http://localhost:3000")).toBe("https://app.loci.vn/api/gmail/callback");
    const setup = await googleSetup(db, admin, dec);
    expect(setup).toMatchObject({ clientId: CID, hasSecret: true, secretHint: "…t123", secretBroken: false });
    expect(JSON.stringify(setup)).not.toContain("GOCSPX-secret123");
    await expect(googleSetup(db, acc, dec)).rejects.toThrow(/quyền/);
  });
});

describe("Dán email payout trên web", () => {
  it("lưu payout dán tay, khớp đơn, không cho dán trùng (cùng nội dung hoặc cùng mã khoản chi trả)", async () => {
    await expect(importPastedPayout(db, invB, { investorId: "inv-a", text: SAMPLE_PASTE, receivedOn: "2026-10-12" })).rejects.toThrow(/Không tìm thấy/);
    await expect(importPastedPayout(db, invA, { investorId: "inv-a", text: "Đặt phòng đã được xác nhận HMPASTE001", receivedOn: "2026-10-12" })).rejects.toThrow(/dòng tổng tiền/);
    const row = await importPastedPayout(db, invA, { investorId: "inv-a", text: SAMPLE_PASTE, receivedOn: "2026-10-12" });
    expect(row?.gmailAccountId).toBeNull();
    await expect(importPastedPayout(db, invA, { investorId: "inv-a", text: SAMPLE_PASTE, receivedOn: "2026-10-12" })).rejects.toThrow(/PASTECODE0001 đã có/);
    const { payouts, missing } = await payoutsForMonth(db, invA, "2026-10", "2026-10-21");
    const pasted = payouts.find((p) => p.email === null)!;
    expect(pasted.payoutDate).toBe("2026-10-12");
    expect(pasted.groups[0]).toMatchObject({ confirmationCode: "HMPASTE001", guestName: "Le Thi C", checkIn: "2026-10-10", vnd: 800_000, matchStatus: "MATCHED", diffAmount: 0 });
    expect(pasted.groups[0].booking?.id).toBe("b3");
    expect(missing.map((m) => m.bookingId)).not.toContain("b3");
  });

  it("chỉ xóa được payout dán tay; xóa xong đơn lại hiện là chưa thấy payout", async () => {
    const all = await db.select().from(schema.airbnbPayouts);
    const fromGmail = all.find((p) => p.gmailAccountId)!;
    const pasted = all.find((p) => !p.gmailAccountId)!;
    await expect(deletePastedPayout(db, invA, fromGmail.id)).rejects.toThrow(/dán tay/);
    await expect(deletePastedPayout(db, invB, pasted.id)).rejects.toThrow(/Không tìm thấy/);
    await deletePastedPayout(db, invA, pasted.id);
    expect((await db.select().from(schema.airbnbPayoutItems).where(eq(schema.airbnbPayoutItems.payoutId, pasted.id)))).toEqual([]);
    expect((await payoutsForMonth(db, invA, "2026-10", "2026-10-21")).missing.map((m) => m.bookingId)).toEqual(["b3"]);
  });
});

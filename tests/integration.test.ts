// Test tích hợp trên PostgreSQL nhúng (PGlite): chạy migration thật, gọi service thật.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import { allowedPropertyIds, assertPropertyAccess, type SessionUser } from "../lib/auth/access";
import { saveManualBooking, upsertBooking } from "../lib/services/bookings";
import { approveExpenses, createExpense, setCommonFinalized } from "../lib/services/expenses";
import { getSettlement, lockSettlement, paybackForInvestor, unlockSettlement } from "../lib/services/settlement";
import { SYNC_FULL_MAX_ORDERS, SYNC_MAX_ORDERS, syncBookings } from "../lib/dayladau/sync";
import { createRoom, listConnections, listingsForProperty, mapListingToRoom, saveDayladauAccount, saveInvestor, setPropertyAccount, testConnection, type InvestorInfo } from "../lib/dayladau/admin";
import { liveOrdersForMonth } from "../lib/dayladau/live";
import { transferRoom } from "../lib/services/rooms";
import { addTaskPhoto, createTask, setTaskStatus, updateChecklist } from "../lib/services/tasks";
import { createRoom as createRoomInProperty, updateRoom } from "../lib/services/rooms";
import { buildInvestorReport } from "../lib/services/investor-report";
import { setPropertyActive, updateProperty, type UpdatePropertyInput } from "../lib/services/properties";
import { createUser, resetPassword, setUserActive, setUserProperties, updateUser } from "../lib/services/users";
import { verifyLogin } from "../lib/auth/session";
import { bookingChanges } from "../lib/services/booking-changes";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const invB: SessionUser = { id: "u-inv-b", name: "NĐT B", role: "INVESTOR" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };
const hk: SessionUser = { id: "u-hk", name: "Buồng phòng", role: "HOUSEKEEPER" };
const mgr: SessionUser = { id: "u-mgr", name: "Quản lý", role: "MANAGER" };
const emptyInfo: InvestorInfo = {
  name: "", phone: null, email: null, taxCode: null, address: null, bankName: null, bankAccountNo: null, bankAccountName: null,
  managementFeePct: null, contractStartOn: null, contractEndOn: null, contractUrl: null, payoutDay: null, active: true, note: null,
};

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.users).values([
    { id: admin.id, name: admin.name, role: "ADMIN", passwordHash: "x", email: "admin@loci.vn" },
    { id: invA.id, name: invA.name, role: "INVESTOR", passwordHash: "x" },
    { id: invB.id, name: invB.name, role: "INVESTOR", passwordHash: "x" },
    { id: acc.id, name: acc.name, role: "ACCOUNTANT", passwordHash: "x" },
    { id: hk.id, name: hk.name, role: "HOUSEKEEPER", passwordHash: "x" },
    { id: mgr.id, name: mgr.name, role: "MANAGER", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([
    { id: "inv-a", name: "NĐT A", userId: invA.id },
    { id: "inv-b", name: "NĐT B", userId: invB.id },
  ]);
  await db.insert(s.dayladauAccounts).values({ id: "acc-a", investorId: "inv-a", label: "TK A", hostId: "HOST-A", tokenEncrypted: "tok-a" });
  await db.insert(s.properties).values([
    { id: "X", investorId: "inv-a", name: "Vạn Phúc", investmentAmount: 600_000_000, investmentStartMonth: "2026-07", dayladauAccountId: "acc-a" },
    { id: "Y", investorId: "inv-a", name: "Phan Kế Bính", dayladauAccountId: "acc-a" },
    { id: "Z", investorId: "inv-b", name: "Nguyễn Tư Giản" },
  ]);
  await db.insert(s.rooms).values([
    { id: "X1", propertyId: "X", name: "P101", openedOn: "2026-01-01", dayladauAccountId: "acc-a", dayladauRoomId: "DR-X1" },
    { id: "Y1", propertyId: "Y", name: "P101", openedOn: "2026-01-01", dayladauAccountId: "acc-a", dayladauRoomId: "DR-Y1" },
    { id: "Z1", propertyId: "Z", name: "P101", openedOn: "2026-01-01" },
    { id: "Z2", propertyId: "Z", name: "P102", openedOn: "2026-01-01" },
  ]);
  await db.insert(s.userPropertyAccess).values([
    { userId: acc.id, propertyId: "X" }, { userId: acc.id, propertyId: "Y" }, { userId: acc.id, propertyId: "Z" },
    { userId: hk.id, propertyId: "X" }, { userId: mgr.id, propertyId: "X" },
  ]);
  await db.insert(s.expenseCategories).values([
    { id: "rent", name: "Thuê nhà", scope: "DIRECT" },
    { id: "salary", name: "Lương", scope: "COMMON" },
  ]);
});

describe("Phân quyền (giai đoạn 1)", () => {
  it("NĐT A chỉ thấy cơ sở của mình", async () => {
    expect((await allowedPropertyIds(db, invA)).sort()).toEqual(["X", "Y"]);
    expect(await allowedPropertyIds(db, invB)).toEqual(["Z"]);
    await expect(assertPropertyAccess(db, invA, "Z")).rejects.toThrow();
  });

  it("NĐT A không đọc được quyết toán của NĐT B dù gọi trực tiếp", async () => {
    await expect(getSettlement(db, invA, "inv-b", "2026-08")).rejects.toMatchObject({ status: 404 });
    await expect(paybackForInvestor(db, invA, "inv-b")).rejects.toMatchObject({ status: 404 });
  });

  it("Buồng phòng không nhập được chi phí, NĐT không tạo được đơn", async () => {
    await expect(createExpense(db, hk, { propertyId: "X", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-01", amount: 1, description: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(saveManualBooking(db, invA, { propertyId: "X", roomId: "X1", guestName: "a", checkIn: "2026-08-01", checkOut: "2026-08-02", amount: 1, status: "CONFIRMED", transferProofUrl: "x" })).rejects.toMatchObject({ status: 403 });
  });
});

describe("Doanh thu, chi phí, quyết toán (giai đoạn 2)", () => {
  it("quyết toán tháng 8: X lãi 30tr, Y lỗ 5tr → phí 5tr, NĐT nhận 20tr", async () => {
    await saveManualBooking(db, mgr, { propertyId: "X", roomId: "X1", guestName: "Khách X", checkIn: "2026-08-01", checkOut: "2026-08-11", amount: 40_000_000, status: "CONFIRMED", transferProofUrl: "ck.jpg" });
    await saveManualBooking(db, admin, { propertyId: "Y", roomId: "Y1", guestName: "Khách Y", checkIn: "2026-08-01", checkOut: "2026-08-02", amount: 1_000_000, status: "CONFIRMED", transferProofUrl: "ck.jpg" });
    const ex = await createExpense(db, acc, { propertyId: "X", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-05", amount: 10_000_000, description: "Thuê nhà X" });
    const ey = await createExpense(db, acc, { propertyId: "Y", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-05", amount: 6_000_000, description: "Thuê nhà Y" });
    await setCommonFinalized(db, acc, "2026-08", true);
    // Chưa duyệt: chi phí chưa được ghi nhận
    expect((await getSettlement(db, invA, "inv-a", "2026-08")).lines.find((l) => l.propertyId === "X")!.profit).toBe(40_000_000);
    await approveExpenses(db, invA, [ex.id, ey.id]);
    const s = await getSettlement(db, invA, "inv-a", "2026-08");
    expect(s.lines.find((l) => l.propertyId === "X")!.profit).toBe(30_000_000);
    expect(s.lines.find((l) => l.propertyId === "Y")!.profit).toBe(-5_000_000);
    expect(s.managementFee).toBe(5_000_000);
    expect(s.investorNet).toBe(20_000_000);
    expect(s.status).toBe("DRAFT");
  });

  it("chặn đơn trùng phòng", async () => {
    await expect(saveManualBooking(db, mgr, { propertyId: "X", roomId: "X1", guestName: "Trùng", checkIn: "2026-08-05", checkOut: "2026-08-06", amount: 1, status: "CONFIRMED", transferProofUrl: "x" })).rejects.toThrow(/đã có khách/);
  });

  it("chỉ Admin khóa sổ; sau khi khóa không sửa được chi phí tháng đó", async () => {
    await expect(lockSettlement(db, acc, "inv-a", "2026-08")).rejects.toMatchObject({ status: 403 });
    await lockSettlement(db, admin, "inv-a", "2026-08");
    const s = await getSettlement(db, invA, "inv-a", "2026-08");
    expect(s.status).toBe("LOCKED");
    expect(s.investorNet).toBe(20_000_000);
    await expect(createExpense(db, acc, { propertyId: "X", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-20", amount: 100_000, description: "Muộn" })).rejects.toThrow(/khóa sổ/);
    // NĐT B chưa khóa → vẫn nhập được chi phí cơ sở Z
    await createExpense(db, acc, { propertyId: "Z", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-20", amount: 100_000, description: "Z" });
  });

  it("mở khóa bắt buộc lý do", async () => {
    await expect(unlockSettlement(db, admin, "inv-a", "2026-08", " ")).rejects.toThrow(/lý do/);
  });

  it("hoàn vốn đọc từ tháng đã khóa", async () => {
    const p = await paybackForInvestor(db, invA, "inv-a");
    expect(p.received).toBe(20_000_000);
    expect(p.remaining).toBe(580_000_000);
  });

  it("báo cáo NĐT: doanh thu từng phòng, dự kiến và KPI", async () => {
    await expect(updateRoom(db, acc, "X1", { revenueKpiMonthly: 50_000_000 })).rejects.toMatchObject({ status: 403 });
    await updateRoom(db, admin, "X1", { revenueKpiMonthly: 50_000_000 });
    const r = await buildInvestorReport(db, invA, "inv-a", "2026-08", null);
    expect(r.rooms.elapsedDays).toBe(31); // tháng đã qua → đủ tháng, dự kiến = thực tế
    expect(r.rooms.rows).toEqual([
      { roomId: "Y1", name: "Phan Kế Bính. P101", revenue: 1_000_000, projected: 1_000_000, kpi: 0 },
      { roomId: "X1", name: "Vạn Phúc. P101", revenue: 40_000_000, projected: 40_000_000, kpi: 50_000_000 },
    ]);
    const one = await buildInvestorReport(db, invA, "inv-a", "2026-08", "X");
    expect(one.rooms.rows.map((x) => x.roomId)).toEqual(["X1"]);
  });

  it("báo cáo NĐT: BHXH, Kế toán trả dưới dạng chi phí chung được tách khỏi CP Homestay", async () => {
    await db.insert(schema.expenseCategories).values([
      { id: "bhxh", name: "BHXH", scope: "COMMON" },
      { id: "kt", name: "Kế toán", scope: "COMMON" },
    ]);
    const mk = (categoryId: string, amount: number) =>
      createExpense(db, acc, { propertyId: null, categoryId, month: "2026-10", incurredOn: "2026-10-05", amount, description: categoryId });
    const ids = [(await mk("bhxh", 4_000_000)).id, (await mk("kt", 2_000_000)).id, (await mk("salary", 2_000_000)).id];
    await approveExpenses(db, admin, ids);
    await setCommonFinalized(db, acc, "2026-10", true);
    const cur = (await buildInvestorReport(db, invA, "inv-a", "2026-10", null)).months[3];
    // 8tr chi phí chung ÷ 4 phòng; NĐT A có 2 phòng → 4tr, chia theo tỷ trọng loại
    expect(cur).toMatchObject({ bhxh: 2_000_000, accounting: 1_000_000 });
    expect(cur.homestayByCategory["Chi phí chung được chia"]).toBe(1_000_000);
    expect(cur.homestay + cur.bhxh + cur.accounting).toBe(4_000_000);
  });

  it("báo cáo NĐT của CĐT đặc biệt: CP Thuế là GTGT + TNCN tự tính, khớp quyết toán; tháng đã khóa giữ như cũ", async () => {
    await saveInvestor(db, admin, { ...emptyInfo, id: "inv-a", name: "NĐT A", vatPct: 8, pitPct: 17 });
    try {
      const r = await buildInvestorReport(db, invA, "inv-a", "2026-09", null);
      const cur = r.months[3];
      const st = await getSettlement(db, invA, "inv-a", "2026-09");
      expect(cur.autoTax).toEqual({ vatPct: 8, pitPct: 17 });
      expect(cur).toMatchObject({ vat: st.vat, cit: st.pit, tax: st.vat + st.pit, host: st.managementFee, net: st.investorNet });
      expect(r.months[2].autoTax).toBeNull(); // 08/2026 đã khóa sổ trước khi đặt thuế
    } finally {
      await saveInvestor(db, admin, { ...emptyInfo, id: "inv-a", name: "NĐT A", vatPct: null, pitPct: null });
    }
  });
});

describe("Đồng bộ Dayladau (giả lập API)", () => {
  // Đúng cấu trúc order trong script Apps Script của LOCI
  const raw = (over: { id?: string; listing?: string; checkin?: string; checkout?: string; status?: string } = {}) => ({
    id: over.id ?? "DLD-1",
    total_billed: 3_000_000,
    status: over.status ?? "confirmed",
    listing: { id: over.listing ?? "DR-X1", name: "Vạn Phúc P101" },
    guest: { fullname: "Emma", phone: "0900000000" },
    guest_id: 1,
    created_at: "2026-08-15T10:00:00+07:00",
    reservation: { start_time: `${over.checkin ?? "2026-08-30"}T14:00:00+07:00`, end_time: `${over.checkout ?? "2026-09-02"}T12:00:00+07:00`, subtotal_detail_v2: { type_rental: "night" } },
    items: [{ amount: 3_000_000, commission_rates: [{ type: "host", rate: 0.85 }, { type: "platform", rate: 0.15 }] }],
  });
  let apiData: ReturnType<typeof raw>[] = [];
  const client = { listBookings: async () => apiData };

  it("tạo đơn mới, bỏ qua phòng chưa map", async () => {
    // Tháng 8 của NĐT A đã khóa, nên dùng đơn chỉ nằm trong tháng 9 cho lần tạo đầu
    apiData = [raw({ checkin: "2026-09-10", checkout: "2026-09-12" }), raw({ id: "DLD-2", listing: "DR-UNKNOWN" })];
    const r = await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s });
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1);
    const alerts = await db.select().from(schema.alerts).where(eq(schema.alerts.type, "UNMAPPED_ROOM"));
    expect(alerts).toHaveLength(1);
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "DLD-1"));
    expect(b.netAmount).toBe(2_550_000);
  });

  it("chạy lại không đổi gì → unchanged", async () => {
    const r = await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s });
    expect(r.unchanged).toBe(1);
    expect(r.created + r.updated).toBe(0);
  });

  it("đơn không đổi chỉ cập nhật giờ đồng bộ; đổi tên khách vẫn được ghi", async () => {
    const ext = eq(schema.bookings.externalId, "DLD-1");
    await db.update(schema.bookings).set({ lastSyncedAt: new Date("2026-01-01") }).where(ext);
    const logsBefore = (await db.select().from(schema.bookingChangeLogs)).length;
    expect(await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s })).toMatchObject({ unchanged: 1, created: 0, updated: 0 });
    const [b] = await db.select().from(schema.bookings).where(ext);
    expect(b.lastSyncedAt!.getTime()).toBeGreaterThan(new Date("2026-09-01").getTime());
    const before = apiData;
    apiData = [{ ...apiData[0], guest: { fullname: "Emma Watson", phone: "0900000000" } }, apiData[1]];
    expect(await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s })).toMatchObject({ unchanged: 1, updated: 0 });
    expect((await db.select().from(schema.bookings).where(ext))[0].guestName).toBe("Emma Watson");
    expect((await db.select().from(schema.bookingChangeLogs)).length).toBe(logsBefore);
    apiData = before;
    await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s });
  });

  it("đồng bộ theo tháng: đọc toàn bộ lịch sử, chỉ ghi đơn có đêm trong tháng", async () => {
    const asked: (number | undefined)[] = [];
    const byMonth = { listBookings: async ({ maxOrders }: { maxOrders?: number }) => { asked.push(maxOrders); return apiData; } };
    // DLD-1 đổi ngày nhưng vẫn nằm ngoài tháng 10 → không ghi; listing chưa gắn ngoài tháng cũng không tính bỏ qua
    apiData = [raw({ checkin: "2026-09-11", checkout: "2026-09-13" }), raw({ id: "DLD-2", listing: "DR-UNKNOWN" })];
    const oct = await syncBookings(db, { client: byMonth, today: "2026-09-30", decrypt: (s) => s, month: "2026-10" });
    expect(oct).toMatchObject({ created: 0, updated: 0, unchanged: 0, skipped: 0 });
    expect(asked).toEqual([SYNC_FULL_MAX_ORDERS]);
    apiData = [raw({ checkin: "2026-09-10", checkout: "2026-09-12" }), raw({ id: "DLD-2", listing: "DR-UNKNOWN" })];
    const sep = await syncBookings(db, { client: byMonth, today: "2026-09-30", decrypt: (s) => s, month: "2026-09" });
    expect(sep).toMatchObject({ created: 0, unchanged: 1 });
  });

  it("đơn đổi ngày lùi vào tháng 8 đã khóa → điều chỉnh ghi vào tháng 9", async () => {
    apiData = [raw({ checkin: "2026-08-30", checkout: "2026-09-02" }), raw({ id: "DLD-2", listing: "DR-UNKNOWN" })];
    const r = await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s });
    expect(r.updated).toBe(1);
    expect(r.adjustments).toBe(1);
    const [adj] = await db.select().from(schema.adjustments);
    expect(adj).toMatchObject({ propertyId: "X", originalMonth: "2026-08", appliedMonth: "2026-09", amount: 1_700_000 });
    // Quyết toán tháng 8 đã khóa giữ nguyên
    expect((await getSettlement(db, invA, "inv-a", "2026-08")).investorNet).toBe(20_000_000);
    // Tháng 9 có dòng điều chỉnh
    const sep = await getSettlement(db, admin, "inv-a", "2026-09");
    expect(sep.lines.find((l) => l.propertyId === "X")!.adjustments).toBe(1_700_000);
    const logs = await db.select().from(schema.bookingChangeLogs).where(eq(schema.bookingChangeLogs.changedBy, "SYNC"));
    expect(logs.length).toBe(2);
  });

  it("phòng tạo lại sau khi đã có đơn: đồng bộ kéo ngày mở bán về đơn đầu tiên", async () => {
    const x1 = eq(schema.rooms.id, "X1");
    // Giống Vạn Phúc: phòng tạo lại/gắn lại listing nên ngày mở bán thành hôm nay, muộn hơn các đơn đã có
    await db.update(schema.rooms).set({ openedOn: "2026-09-29" }).where(x1);
    await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s });
    expect((await db.select().from(schema.rooms).where(x1))[0].openedOn).toBe("2026-08-01");
    // Phòng mở sớm hơn đơn đầu tiên thì giữ nguyên
    await db.update(schema.rooms).set({ openedOn: "2026-01-01" }).where(x1);
    await syncBookings(db, { client, today: "2026-09-30", decrypt: (s) => s });
    expect((await db.select().from(schema.rooms).where(x1))[0].openedOn).toBe("2026-01-01");
  });

  it("lỗi API của một NĐT tạo cảnh báo SYNC_FAILED, không ném lỗi", async () => {
    const bad = { listBookings: async () => { throw new Error("Token hết hạn"); } };
    const r = await syncBookings(db, { client: bad, today: "2026-09-30", decrypt: (s) => s });
    expect(r.errors[0].message).toMatch(/Token/);
    expect((await db.select().from(schema.alerts).where(eq(schema.alerts.type, "SYNC_FAILED"))).length).toBe(1);
  });
});

describe("Công việc (giai đoạn 4)", () => {
  it("dọn phòng: cần checklist đủ và ảnh trước khi hoàn thành; buồng phòng chỉ làm việc của mình", async () => {
    const t = await createTask(db, mgr, { propertyId: "X", roomId: "X1", type: "CLEANING", title: "Dọn P101", assigneeId: hk.id, dueAt: new Date("2026-09-30T07:00:00Z"), recurrenceRule: null });
    await expect(setTaskStatus(db, hk, t.id, "DONE")).rejects.toThrow(/ảnh/);
    await addTaskPhoto(db, hk, t.id, "https://img/1.jpg");
    await expect(setTaskStatus(db, hk, t.id, "DONE")).rejects.toThrow(/checklist/);
    const [cl] = await db.select().from(schema.checklistResults).where(eq(schema.checklistResults.taskId, t.id));
    await updateChecklist(db, hk, t.id, (cl.results as { item: string }[]).map((r) => ({ item: r.item, done: true })));
    await setTaskStatus(db, hk, t.id, "DONE");
    const [done] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id));
    expect(done.status).toBe("DONE");
  });

  it("việc định kỳ sinh lần kế tiếp khi hoàn thành", async () => {
    const t = await createTask(db, mgr, { propertyId: "X", type: "RECURRING", title: "Vệ sinh lưới lọc", assigneeId: mgr.id, dueAt: new Date("2026-09-05T10:00:00Z"), recurrenceRule: "monthly:5" });
    await setTaskStatus(db, mgr, t.id, "DONE");
    const next = await db.select().from(schema.tasks).where(and(eq(schema.tasks.title, "Vệ sinh lưới lọc"), eq(schema.tasks.status, "TODO")));
    expect(next).toHaveLength(1);
    expect(next[0].dueAt.toISOString()).toBe("2026-10-05T10:00:00.000Z");
  });
});

describe("Quản trị kết nối Dayladau", () => {
  const enc = (t: string) => `enc:${t}`;
  const dec = (t: string) => t.replace(/^enc:/, "");
  let accB = "";

  it("chỉ Admin được lưu nhà đầu tư, host ID và token", async () => {
    await expect(saveDayladauAccount(db, acc, { investorId: "inv-b", label: "X", hostId: "abc123", token: "t".repeat(20) }, enc)).rejects.toMatchObject({ status: 403 });
    await expect(saveInvestor(db, acc, { ...emptyInfo, name: "X" })).rejects.toMatchObject({ status: 403 });
  });

  it("lưu token dạng mã hóa, không trả token ra ngoài", async () => {
    const a = await saveDayladauAccount(db, admin, { investorId: "inv-b", label: "TK NTG", hostId: "host-b-01", token: "secret-token-bbbbbbbbbbbb1234", propertyIds: ["Z"] }, enc);
    accB = a.id;
    expect(JSON.stringify(a)).not.toContain("secret-token");
    const [row] = await db.select().from(schema.dayladauAccounts).where(eq(schema.dayladauAccounts.id, accB));
    expect(row).toMatchObject({ tokenEncrypted: "enc:secret-token-bbbbbbbbbbbb1234", tokenLast4: "1234" });
    // Sửa tên, để trống token → giữ token cũ
    await saveDayladauAccount(db, admin, { id: accB, investorId: "inv-b", label: "TK NTG mới", hostId: "host-b-01" }, enc);
    const [row2] = await db.select().from(schema.dayladauAccounts).where(eq(schema.dayladauAccounts.id, accB));
    expect(row2).toMatchObject({ label: "TK NTG mới", tokenEncrypted: "enc:secret-token-bbbbbbbbbbbb1234" });
    const list = await listConnections(db, admin, dec);
    expect(list.find((i) => i.id === "inv-b")?.accounts).toEqual([expect.objectContaining({ hostId: "host-b-01", tokenHint: "…1234", propertyIds: ["Z"] })]);
    expect(JSON.stringify(list)).not.toContain("secret-token");
  });

  it("chặn host ID trùng và token có ký tự lạ", async () => {
    await expect(saveDayladauAccount(db, admin, { investorId: "inv-a", label: "Mới", hostId: "host-b-01", token: "x".repeat(20) }, enc)).rejects.toThrow(/đã có tài khoản/);
    await expect(saveDayladauAccount(db, admin, { investorId: "inv-a", label: "Mới", hostId: "host-new", token: "abc def ghi jkl mno" }, enc)).rejects.toThrow(/token/);
  });

  it("kiểm tra kết nối liệt kê listing và trạng thái; gắn listing rồi đồng bộ được", async () => {
    const orders = [
      { id: "B-1", total_billed: 1_000_000, status: "confirmed", listing: { id: 501, name: "NTG P101" }, reservation: { start_time: "2026-09-20", end_time: "2026-09-21" }, items: [{ amount: 1_000_000, commission_rates: [{ type: "host", rate: 0.8 }] }] },
      { id: "B-2", total_billed: 900_000, status: "canceled", listing: { id: 502, name: "NTG P102" }, reservation: { start_time: "2026-09-22", end_time: "2026-09-23" }, items: [] },
    ];
    const t = await testConnection(db, admin, accB, { fetchPage: async () => orders, decrypt: dec });
    expect(t.ok).toBe(true);
    expect(t.listings.map((l) => [l.key, l.roomId])).toEqual([["501", null], ["502", null]]);
    expect(t.statuses).toEqual(expect.arrayContaining([{ status: "canceled", orders: 1, treatedAs: "CANCELLED" }]));
    expect(t.samples[0]).toMatchObject({ id: "B-1", hostAmount: 800_000 });
    expect(JSON.stringify(t)).not.toMatch(/fullname|phone/);

    await mapListingToRoom(db, admin, accB, "501", "Z1");
    // Phòng của cơ sở dùng tài khoản khác
    await expect(mapListingToRoom(db, admin, accB, "502", "X1")).rejects.toThrow(/không thuộc/);
    await createRoom(db, admin, { propertyId: "Z", name: "P103", openedOn: "2026-01-01", listingKey: "503" });
    // Thiếu / sai cơ sở: báo lỗi nghiệp vụ, không để lọt lỗi khóa ngoại thành "Lỗi máy chủ"
    await expect(createRoom(db, admin, { propertyId: "", name: "P104", openedOn: "2026-01-01", listingKey: "504" })).rejects.toThrow(/Chọn cơ sở/);
    await expect(createRoom(db, admin, { propertyId: "khong-co", name: "P104", openedOn: "2026-01-01", listingKey: "504" })).rejects.toThrow(/cơ sở/);
    // Tạo phòng mới cho listing đang gắn phòng khác cùng tài khoản: chuyển listing sang phòng mới
    const p104 = await createRoom(db, admin, { propertyId: "Z", name: "P104", openedOn: "2026-01-01", listingKey: "503" });
    const byListing = await db.select({ id: schema.rooms.id }).from(schema.rooms).where(eq(schema.rooms.dayladauRoomId, "503"));
    expect(byListing).toEqual([{ id: p104.id }]);

    const asked: number[] = [];
    const client = { listBookings: async (o: { maxOrders?: number }) => { asked.push(o.maxOrders!); return orders; } };
    const r = await syncBookings(db, { client, today: "2026-09-30", decrypt: dec, accountIds: [accB] });
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1); // 502 chưa gắn phòng
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "B-1"));
    expect(b).toMatchObject({ roomId: "Z1", netAmount: 800_000, commissionAmount: 200_000 });
    // Lần đầu lấy toàn bộ đơn cũ; khi đã có đơn thì chỉ lấy đơn mới nhất, trừ khi Admin bấm lấy toàn bộ
    await syncBookings(db, { client, today: "2026-09-30", decrypt: dec, accountIds: [accB] });
    await syncBookings(db, { client, today: "2026-09-30", decrypt: dec, accountIds: [accB], full: true });
    expect(asked).toEqual([SYNC_FULL_MAX_ORDERS, SYNC_MAX_ORDERS, SYNC_FULL_MAX_ORDERS]);
    const [a] = await db.select().from(schema.dayladauAccounts).where(eq(schema.dayladauAccounts.id, accB));
    expect(a.lastSyncStatus).toBe("OK");
  });

  it("kết nối lỗi trả thông báo, không ném lỗi", async () => {
    const t = await testConnection(db, admin, accB, { fetchPage: async () => { throw new Error("Host ID hoặc access token không hợp lệ (HTTP 401)"); }, decrypt: dec });
    expect(t).toMatchObject({ ok: false, error: expect.stringMatching(/không hợp lệ/) });
  });
});

describe("Phòng: tên không được để trống", () => {
  it("tạo phòng: chặn tên rỗng, cắt khoảng trắng hai đầu", async () => {
    await expect(createRoomInProperty(db, admin, { propertyId: "Z", name: "   ", openedOn: "2026-01-01" })).rejects.toMatchObject({ status: 400, message: "Nhập tên phòng" });
    const r = await createRoomInProperty(db, admin, { propertyId: "Z", name: "  P201  ", openedOn: "2026-01-01" });
    expect(r.name).toBe("P201");
  });

  it("sửa phòng: chặn tên rỗng, cắt khoảng trắng hai đầu", async () => {
    await expect(updateRoom(db, admin, "Z2", { name: "" })).rejects.toMatchObject({ status: 400, message: "Nhập tên phòng" });
    expect((await updateRoom(db, admin, "Z2", { name: " P102A " })).name).toBe("P102A");
  });
});

describe("Cơ sở: sửa thông tin, ngưng / mở lại", () => {
  const base: UpdatePropertyInput = {
    name: "Cơ sở thử", address: null, investmentAmount: 0, investmentStartMonth: null,
    occupancyKpiPct: 70, variableCostPerNight: 0, fixedCostMonthly: 0,
  };

  beforeAll(async () => {
    await db.insert(schema.properties).values({ id: "W", investorId: "inv-b", name: "Cơ sở thử" });
    await db.insert(schema.rooms).values({ id: "W1", propertyId: "W", name: "P101", openedOn: "2026-01-01" });
  });

  it("chỉ admin được sửa", async () => {
    await expect(updateProperty(db, acc, "W", base)).rejects.toMatchObject({ status: 403 });
    await expect(setPropertyActive(db, invB, "W", false, "2026-08-01")).rejects.toMatchObject({ status: 403 });
  });

  it("kiểm tra dữ liệu nhập", async () => {
    await expect(updateProperty(db, admin, "W", { ...base, name: "  " })).rejects.toThrow(/Nhập tên cơ sở/);
    await expect(updateProperty(db, admin, "W", { ...base, occupancyKpiPct: 101 })).rejects.toThrow(/KPI/);
    await expect(updateProperty(db, admin, "W", { ...base, occupancyKpiPct: -1 })).rejects.toThrow(/KPI/);
    await expect(updateProperty(db, admin, "W", { ...base, investmentStartMonth: "2026-7" })).rejects.toThrow(/Tháng bắt đầu/);
    await expect(updateProperty(db, admin, "khong-co", base)).rejects.toMatchObject({ status: 404 });
  });

  it("lưu thông tin, cắt khoảng trắng, địa chỉ rỗng thành null", async () => {
    const row = await updateProperty(db, admin, "W", {
      ...base, name: " Cơ sở W ", address: "   ", investmentAmount: 300_000_000, investmentStartMonth: "2026-09", occupancyKpiPct: 80,
    });
    expect(row).toMatchObject({ name: "Cơ sở W", address: null, investmentAmount: 300_000_000, investmentStartMonth: "2026-09", occupancyKpiPct: 80 });
    expect((await updateProperty(db, admin, "W", { ...base, address: " 12 Hàng Bạc " })).address).toBe("12 Hàng Bạc");
  });

  it("không ngưng được khi còn đơn chưa trả phòng; đơn đã huỷ hoặc đã trả thì được", async () => {
    await db.insert(schema.bookings).values([
      { id: "bw-open", source: "MANUAL", propertyId: "W", roomId: "W1", channel: "Trực tiếp", checkIn: "2026-08-10", checkOut: "2026-08-12", status: "CONFIRMED" },
      { id: "bw-cancel", source: "MANUAL", propertyId: "W", roomId: "W1", channel: "Trực tiếp", checkIn: "2026-08-20", checkOut: "2026-08-22", status: "CANCELLED" },
    ]);
    await expect(setPropertyActive(db, admin, "W", false, "2026-08-01")).rejects.toThrow(/chưa trả phòng/);
    // Ngày trả phòng = hôm nay coi như đã trả
    expect((await setPropertyActive(db, admin, "W", false, "2026-08-12")).active).toBe(false);
    await expect(createRoomInProperty(db, admin, { propertyId: "W", name: "P102", openedOn: "2026-08-12" })).rejects.toThrow(/ngưng hoạt động/);
    expect((await setPropertyActive(db, admin, "W", true, "2026-08-12")).active).toBe(true);
  });

  it("cơ sở không tồn tại trả 404", async () => {
    await expect(setPropertyActive(db, admin, "khong-co", true, "2026-08-01")).rejects.toMatchObject({ status: 404 });
  });
});

describe("Tài khoản theo vị trí", () => {
  const base = { password: "matkhau123" };

  it("chỉ Admin tạo được tài khoản", async () => {
    await expect(createUser(db, mgr, { ...base, name: "X", phone: "0900000001", role: "HOUSEKEEPER", propertyIds: ["X"] })).rejects.toMatchObject({ status: 403 });
  });

  it("nhân viên chỉ thấy cơ sở được giao, đăng nhập được bằng số điện thoại có dấu cách", async () => {
    const u = await createUser(db, admin, { ...base, name: " Chị Lan ", phone: "0912 345 678", role: "HOUSEKEEPER", propertyIds: ["X", "Y", "X"] });
    expect(u).toMatchObject({ name: "Chị Lan", role: "HOUSEKEEPER" });
    expect((await allowedPropertyIds(db, { id: u.id, name: u.name, role: u.role })).sort()).toEqual(["X", "Y"]);
    expect((await verifyLogin(db, "0912.345.678", "matkhau123")).id).toBe(u.id);

    await setUserProperties(db, admin, u.id, ["Z"]);
    expect(await allowedPropertyIds(db, { id: u.id, name: u.name, role: u.role })).toEqual(["Z"]);
    await expect(setUserProperties(db, admin, u.id, [])).rejects.toThrow(/ít nhất một cơ sở/);
  });

  it("chặn trùng số điện thoại / email, thiếu cơ sở, mật khẩu ngắn", async () => {
    await expect(createUser(db, admin, { ...base, name: "Trùng", phone: "0912345678", role: "MANAGER", propertyIds: ["X"] })).rejects.toThrow(/Số điện thoại đã có/);
    await expect(createUser(db, admin, { ...base, name: "Trùng", email: "ADMIN@loci.vn", role: "ADMIN" })).rejects.toThrow(/Email đã có/);
    await expect(createUser(db, admin, { ...base, name: "Không cơ sở", phone: "0900000002", role: "ACCOUNTANT", propertyIds: [] })).rejects.toThrow(/ít nhất một cơ sở/);
    await expect(createUser(db, admin, { name: "Ngắn", phone: "0900000003", role: "ADMIN", password: "123" })).rejects.toThrow(/8 ký tự/);
    await expect(createUser(db, admin, { ...base, name: "Không liên hệ", role: "ADMIN" })).rejects.toThrow(/số điện thoại hoặc email/);
  });

  it("NĐT gắn chủ đầu tư chưa có tài khoản, không gắn được chủ đầu tư đã có", async () => {
    await db.insert(schema.investors).values({ id: "inv-free", name: "NĐT mới" });
    await db.insert(schema.properties).values({ id: "F", investorId: "inv-free", name: "Cơ sở F" });
    const u = await createUser(db, admin, { ...base, name: "Anh Minh", email: "minh@x.vn", role: "INVESTOR", investorId: "inv-free" });
    expect(await allowedPropertyIds(db, { id: u.id, name: u.name, role: u.role })).toEqual(["F"]);
    await expect(createUser(db, admin, { ...base, name: "Cướp", email: "cuop@x.vn", role: "INVESTOR", investorId: "inv-a" })).rejects.toThrow(/đã có tài khoản/);
    // Giao dịch rollback: không để lại tài khoản mồ côi
    expect(await db.select().from(schema.users).where(eq(schema.users.email, "cuop@x.vn"))).toEqual([]);

    const fresh = await createUser(db, admin, { ...base, name: "Chị Hoa", email: "hoa@x.vn", role: "INVESTOR" });
    const [inv] = await db.select().from(schema.investors).where(eq(schema.investors.userId, fresh.id));
    expect(inv.name).toBe("Chị Hoa");
  });

  it("khóa tài khoản chặn đăng nhập; không tự khóa mình", async () => {
    const u = await createUser(db, admin, { ...base, name: "Kế toán 2", email: "kt2@x.vn", role: "ACCOUNTANT", propertyIds: ["X"] });
    await setUserActive(db, admin, u.id, false);
    await expect(verifyLogin(db, "kt2@x.vn", "matkhau123")).rejects.toMatchObject({ status: 401 });
    await resetPassword(db, admin, u.id, "moimoi1234");
    await setUserActive(db, admin, u.id, true);
    expect((await verifyLogin(db, "kt2@x.vn", "moimoi1234")).id).toBe(u.id);
    await expect(setUserActive(db, admin, admin.id, false)).rejects.toThrow(/tự khóa/);
  });

  it("sửa thông tin không được trùng tài khoản khác", async () => {
    const u = await createUser(db, admin, { ...base, name: "Quản lý 2", phone: "0988000111", role: "MANAGER", propertyIds: ["Y"] });
    await expect(updateUser(db, admin, u.id, { name: "Quản lý 2", phone: "0912345678" })).rejects.toThrow(/Số điện thoại đã có/);
    await updateUser(db, admin, u.id, { name: "Quản lý Hai", phone: "0988000111", email: "ql2@x.vn" });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row).toMatchObject({ name: "Quản lý Hai", email: "ql2@x.vn" });
  });
});

describe("Đơn đã cập nhật", () => {
  it("phân loại đơn mới / đổi / hủy, lọc theo cơ sở và ẩn số tiền với buồng phòng", async () => {
    const since = new Date(Date.now() - 1000);
    const base = { source: "DAYLADAU" as const, externalId: "CHG-1", propertyId: "X", roomId: "X1", channel: "Airbnb", guestName: "Khách Đổi", checkIn: "2026-12-10", checkOut: "2026-12-12", grossAmount: 2_000_000, commissionAmount: 0, netAmount: 2_000_000, status: "CONFIRMED" as const };
    await upsertBooking(db, base, "SYNC");
    await upsertBooking(db, { ...base, netAmount: 1_800_000 }, "SYNC");
    await upsertBooking(db, { ...base, netAmount: 1_800_000, checkOut: "2026-12-13" }, "SYNC");
    await upsertBooking(db, { ...base, netAmount: 1_800_000, checkOut: "2026-12-13", status: "CANCELLED" }, admin.id, "Khách hủy");

    const mine = (rows: Awaited<ReturnType<typeof bookingChanges>>) => rows.filter((c) => c.booking.externalId === "CHG-1");
    const a = mine(await bookingChanges(db, admin, since));
    expect(a.map((c) => c.kind)).toEqual(["CANCELLED", "CHANGED", "CHANGED", "NEW"]);
    expect(a[0]).toMatchObject({ by: "Admin", reason: "Khách hủy" });
    expect(a[1].fields.map((f) => [f.key, f.before, f.after])).toEqual([["checkOut", "2026-12-12", "2026-12-13"]]);
    expect(a[2].fields.map((f) => f.key)).toEqual(["netAmount"]);
    expect(a[3].by).toBe("Đồng bộ Dayladau");

    // Buồng phòng: không thấy số tiền, thay đổi chỉ về tiền bị bỏ
    const h = mine(await bookingChanges(db, hk, since));
    expect(h.map((c) => c.kind)).toEqual(["CANCELLED", "CHANGED", "NEW"]);
    expect(h.every((c) => c.booking.netAmount === null)).toBe(true);
    expect(h[1].fields.map((f) => f.key)).toEqual(["checkOut"]);

    expect(mine(await bookingChanges(db, invB, since))).toEqual([]);

    // Đơn khách đặt từ lâu, nay mới vào hệ thống: không tính là đơn mới
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Ho_Chi_Minh" });
    await upsertBooking(db, { ...base, externalId: "CHG-OLD", bookedAt: "2026-05-01" }, "SYNC");
    await upsertBooking(db, { ...base, externalId: "CHG-FRESH", bookedAt: today }, "SYNC");
    const kinds = Object.fromEntries((await bookingChanges(db, admin, since)).map((c) => [c.booking.externalId, c.kind]));
    expect(kinds).toMatchObject({ "CHG-OLD": "IMPORTED", "CHG-FRESH": "NEW" });
  });
});

describe("Một NĐT nhiều cơ sở, mỗi cơ sở một tài khoản Dayladau", () => {
  const plain = (t: string) => t;
  let accM1 = "";
  let accM2 = "";
  // Listing không có id: mã listing là tên, trùng nhau giữa hai tài khoản
  const order = (id: string, checkIn: string, checkOut: string) => ({
    id, total_billed: 2_000_000, status: "confirmed", listing: { name: "P101" },
    reservation: { start_time: `${checkIn}T14:00:00+07:00`, end_time: `${checkOut}T12:00:00+07:00` },
    items: [{ amount: 2_000_000, commission_rates: [{ type: "host", rate: 0.9 }] }],
  });

  beforeAll(async () => {
    await db.insert(schema.investors).values({ id: "inv-m", name: "NĐT nhiều cơ sở" });
    await db.insert(schema.properties).values([
      { id: "M1", investorId: "inv-m", name: "Hội An" },
      { id: "M2", investorId: "inv-m", name: "Đà Lạt" },
    ]);
    await db.insert(schema.rooms).values([
      { id: "M1a", propertyId: "M1", name: "P101", openedOn: "2026-01-01" },
      { id: "M2a", propertyId: "M2", name: "P101", openedOn: "2026-01-01" },
    ]);
    accM1 = (await saveDayladauAccount(db, admin, { investorId: "inv-m", label: "TK Hội An", hostId: "host-m1", token: "token-m1-aaaaaaaaaaaa", propertyIds: ["M1"] }, plain)).id;
    accM2 = (await saveDayladauAccount(db, admin, { investorId: "inv-m", label: "TK Đà Lạt", hostId: "host-m2", token: "token-m2-bbbbbbbbbbbb", propertyIds: ["M2"] }, plain)).id;
  });

  it("lưu thông tin NĐT, kiểm tra phí, ngày chuyển tiền, hạn hợp đồng", async () => {
    const info = { ...emptyInfo, id: "inv-m", name: " NĐT nhiều cơ sở ", managementFeePct: 30, bankName: " VCB ", bankAccountNo: "0123", payoutDay: 10, contractStartOn: "2026-01-01", contractEndOn: "2028-12-31" };
    await expect(saveInvestor(db, admin, { ...info, managementFeePct: 101 })).rejects.toThrow(/Phí quản lý/);
    await expect(saveInvestor(db, admin, { ...info, payoutDay: 31 })).rejects.toThrow(/Ngày chuyển tiền/);
    await expect(saveInvestor(db, admin, { ...info, contractEndOn: "2025-12-31" })).rejects.toThrow(/kết thúc/);
    const row = await saveInvestor(db, admin, info);
    expect(row).toMatchObject({ name: "NĐT nhiều cơ sở", managementFeePct: 30, bankName: "VCB", payoutDay: 10, contractEndOn: "2028-12-31", active: true });
  });

  it("tài khoản chỉ dùng cho cơ sở của chính NĐT đó", async () => {
    await expect(saveDayladauAccount(db, admin, { id: accM1, investorId: "inv-m", label: "TK Hội An", hostId: "host-m1", propertyIds: ["M1", "X"] }, plain)).rejects.toThrow(/không thuộc/);
    await expect(setPropertyAccount(db, admin, "M1", "acc-a")).rejects.toThrow(/nhà đầu tư khác/);
    await expect(listingsForProperty(db, admin, "W")).rejects.toThrow(/chưa chọn tài khoản/);
  });

  it("cùng mã listing ở hai tài khoản gắn được hai phòng khác nhau", async () => {
    await mapListingToRoom(db, admin, accM1, "P101", "M1a");
    await mapListingToRoom(db, admin, accM2, "P101", "M2a");
    // Phòng của cơ sở dùng tài khoản kia thì không gắn được
    await expect(mapListingToRoom(db, admin, accM1, "P101", "M2a")).rejects.toThrow(/không thuộc/);
    await mapListingToRoom(db, admin, accM1, "P101", "M1a");
    const rows = await db.select({ id: schema.rooms.id, acc: schema.rooms.dayladauAccountId }).from(schema.rooms).where(eq(schema.rooms.dayladauRoomId, "P101"));
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: "M1a", acc: accM1 }, { id: "M2a", acc: accM2 }]);
  });

  it("đồng bộ gọi riêng từng tài khoản, đơn về đúng cơ sở", async () => {
    const byHost: Record<string, ReturnType<typeof order>[]> = { "host-m1": [order("M-1", "2026-09-10", "2026-09-12")], "host-m2": [order("M-2", "2026-09-15", "2026-09-16")] };
    const calls: string[] = [];
    const client = { listBookings: async ({ hostId, token }: { hostId: string; token: string }) => { calls.push(`${hostId}:${token}`); return byHost[hostId] ?? []; } };
    const r = await syncBookings(db, { client, today: "2026-09-30", decrypt: plain, investorIds: ["inv-m"] });
    expect(calls.sort()).toEqual(["host-m1:token-m1-aaaaaaaaaaaa", "host-m2:token-m2-bbbbbbbbbbbb"]);
    expect(r).toMatchObject({ created: 2, skipped: 0, errors: [] });
    const bs = await db.select({ ext: schema.bookings.externalId, prop: schema.bookings.propertyId, room: schema.bookings.roomId }).from(schema.bookings).where(eq(schema.bookings.externalId, "M-1"));
    expect(bs).toEqual([{ ext: "M-1", prop: "M1", room: "M1a" }]);
    const [m2] = await db.select({ room: schema.bookings.roomId }).from(schema.bookings).where(eq(schema.bookings.externalId, "M-2"));
    expect(m2.room).toBe("M2a");
  });

  it("đồng bộ một tài khoản không báo nhầm đơn của tài khoản kia là đã mất", async () => {
    const client = { listBookings: async ({ hostId }: { hostId: string }) => (hostId === "host-m1" ? [order("M-1", "2026-09-10", "2026-09-12")] : []) };
    await syncBookings(db, { client, today: "2026-09-30", decrypt: plain, accountIds: [accM1] });
    const missing = await db.select().from(schema.alerts).where(and(eq(schema.alerts.type, "BOOKING_MISSING"), eq(schema.alerts.propertyId, "M2")));
    expect(missing).toEqual([]);
  });

  it("một tài khoản lỗi không ảnh hưởng tài khoản còn lại; ghi trạng thái theo tài khoản", async () => {
    const client = { listBookings: async ({ hostId }: { hostId: string }) => { if (hostId === "host-m2") throw new Error("Token hết hạn"); return [order("M-1", "2026-09-10", "2026-09-12")]; } };
    const r = await syncBookings(db, { client, today: "2026-09-30", decrypt: plain, investorIds: ["inv-m"] });
    expect(r.unchanged).toBe(1);
    expect(r.errors).toEqual([{ accountId: accM2, investorId: "inv-m", message: "Token hết hạn" }]);
    const accs = await db.select().from(schema.dayladauAccounts).where(eq(schema.dayladauAccounts.investorId, "inv-m"));
    expect(Object.fromEntries(accs.map((a) => [a.label, a.lastSyncStatus]))).toEqual({ "TK Hội An": "OK", "TK Đà Lạt": "FAILED" });
    const failed = await db.select({ key: schema.alerts.key }).from(schema.alerts).where(eq(schema.alerts.type, "SYNC_FAILED"));
    expect(failed.map((f) => f.key)).toContain(`SYNC_FAILED:${accM2}:2026-09-30`);
  });

  it("tài khoản tạm dừng thì không đồng bộ", async () => {
    await saveDayladauAccount(db, admin, { id: accM2, investorId: "inv-m", label: "TK Đà Lạt", hostId: "host-m2", active: false }, plain);
    const calls: string[] = [];
    await syncBookings(db, { client: { listBookings: async ({ hostId }) => { calls.push(hostId); return []; } }, today: "2026-09-30", decrypt: plain, investorIds: ["inv-m"] });
    expect(calls).toEqual(["host-m1"]);
    await saveDayladauAccount(db, admin, { id: accM2, investorId: "inv-m", label: "TK Đà Lạt", hostId: "host-m2", active: true }, plain);
  });

  it("quyết toán dùng phí quản lý theo hợp đồng NĐT và lưu mức phí khi khóa sổ", async () => {
    const s = await getSettlement(db, admin, "inv-m", "2026-09");
    expect(s.feePct).toBe(30);
    expect(s.managementFee).toBe(s.totalProfit > 0 ? Math.floor((s.totalProfit * 30) / 100) : 0);
  });

  it("đổi tài khoản của cơ sở hoặc chuyển phòng sang cơ sở dùng tài khoản khác thì bỏ gắn listing", async () => {
    await createRoom(db, admin, { propertyId: "M1", name: "P102", openedOn: "2026-01-01", listingKey: "L-9" });
    const [p102] = await db.select().from(schema.rooms).where(eq(schema.rooms.dayladauRoomId, "L-9"));
    const moved = await transferRoom(db, admin, { roomId: p102.id, targetPropertyId: "M2" });
    expect(moved).toMatchObject({ propertyId: "M2", dayladauAccountId: null, dayladauRoomId: null });

    await setPropertyAccount(db, admin, "M2", accM1);
    const [m2a] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, "M2a"));
    expect(m2a).toMatchObject({ dayladauAccountId: null, dayladauRoomId: null });
    const list = await listConnections(db, admin, plain);
    const accs = list.find((i) => i.id === "inv-m")!.accounts;
    expect(Object.fromEntries(accs.map((a) => [a.label, a.propertyIds.sort()]))).toEqual({ "TK Hội An": ["M1", "M2"], "TK Đà Lạt": [] });
  });
});

describe("Một phòng gắn nhiều listing Dayladau", () => {
  const plain = (s: string) => s;
  const order = (id: string, listing: string, checkin: string, checkout: string) => ({
    id, total_billed: 1_000_000, status: "confirmed", listing: { id: listing, name: `Listing ${listing}` }, guest: { fullname: "Khách" }, created_at: "2026-09-01T10:00:00+07:00",
    reservation: { start_time: `${checkin}T14:00:00+07:00`, end_time: `${checkout}T12:00:00+07:00`, subtotal_detail_v2: { type_rental: "night" } },
    items: [{ amount: 1_000_000, commission_rates: [{ type: "host", rate: 0.8 }] }],
  });
  const listingsOf = async (roomId: string) => {
    const [r] = await db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
    const extra = (await db.select().from(schema.roomListings).where(eq(schema.roomListings.roomId, roomId))).map((x) => x.listingKey).sort();
    return { main: r.dayladauRoomId, extra };
  };

  beforeAll(async () => {
    await db.insert(schema.investors).values({ id: "inv-ml", name: "NĐT nhiều listing" });
    await db.insert(schema.dayladauAccounts).values({ id: "acc-ml", investorId: "inv-ml", label: "TK ML", hostId: "HOST-ML", tokenEncrypted: "tok-ml" });
    await db.insert(schema.properties).values({ id: "ML1", investorId: "inv-ml", name: "Cơ sở ML", dayladauAccountId: "acc-ml" });
    await db.insert(schema.rooms).values([
      { id: "ML1a", propertyId: "ML1", name: "101", openedOn: "2026-01-01", dayladauAccountId: "acc-ml", dayladauRoomId: "L-NEW" },
      { id: "ML1b", propertyId: "ML1", name: "102", openedOn: "2026-01-01" },
    ]);
  });

  it("gắn thêm listing cũ vào phòng đã có listing: giữ listing chính, đơn của cả hai listing về cùng phòng", async () => {
    await mapListingToRoom(db, admin, "acc-ml", "L-OLD", "ML1a");
    expect(await listingsOf("ML1a")).toEqual({ main: "L-NEW", extra: ["L-OLD"] });
    const data = [order("ML-1", "L-NEW", "2026-10-02", "2026-10-04"), order("ML-2", "L-OLD", "2026-08-10", "2026-08-12")];
    const r = await syncBookings(db, { client: { listBookings: async () => data }, today: "2026-10-05", decrypt: plain, investorIds: ["inv-ml"] });
    expect(r).toMatchObject({ created: 2, skipped: 0, unmapped: [] });
    const bs = await db.select({ room: schema.bookings.roomId }).from(schema.bookings).where(inArray(schema.bookings.externalId, ["ML-1", "ML-2"]));
    expect(bs.map((b) => b.room)).toEqual(["ML1a", "ML1a"]);
    const conn = await testConnection(db, admin, "acc-ml", { fetchPage: async () => data, decrypt: plain });
    expect(conn.listings.map((l) => [l.key, l.roomId])).toEqual([["L-NEW", "ML1a"], ["L-OLD", "ML1a"]]);
  });

  it("chuyển listing phụ sang phòng khác; bỏ gắn listing chính thì listing phụ lên làm chính", async () => {
    await mapListingToRoom(db, admin, "acc-ml", "L-OLD", "ML1b");
    expect(await listingsOf("ML1a")).toEqual({ main: "L-NEW", extra: [] });
    expect(await listingsOf("ML1b")).toEqual({ main: "L-OLD", extra: [] });
    await mapListingToRoom(db, admin, "acc-ml", "L-OLD", "ML1a");
    await mapListingToRoom(db, admin, "acc-ml", "L-NEW", null);
    expect(await listingsOf("ML1a")).toEqual({ main: "L-OLD", extra: [] });
    expect(await listingsOf("ML1b")).toEqual({ main: null, extra: [] });
  });

  it("đổi listing chính giữ listing phụ; bỏ tài khoản của cơ sở thì bỏ mọi listing", async () => {
    await mapListingToRoom(db, admin, "acc-ml", "L-NEW", "ML1a");
    await updateRoom(db, admin, "ML1a", { dayladauRoomId: "L-NEWER" });
    expect(await listingsOf("ML1a")).toEqual({ main: "L-NEWER", extra: ["L-NEW"] });
    await setPropertyAccount(db, admin, "ML1", null);
    expect(await listingsOf("ML1a")).toEqual({ main: null, extra: [] });
  });
});

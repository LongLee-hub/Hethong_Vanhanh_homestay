// Test tích hợp trên PostgreSQL nhúng (PGlite): chạy migration thật, gọi service thật.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import { allowedPropertyIds, assertPropertyAccess, type SessionUser } from "../lib/auth/access";
import { saveManualBooking } from "../lib/services/bookings";
import { createExpense, setCommonFinalized } from "../lib/services/expenses";
import { getSettlement, lockSettlement, paybackForInvestor, unlockSettlement } from "../lib/services/settlement";
import { syncBookings } from "../lib/dayladau/sync";
import { createRoom, listConnections, mapListingToRoom, saveInvestorConnection, testConnection } from "../lib/dayladau/admin";
import { addTaskPhoto, createTask, setTaskStatus, updateChecklist } from "../lib/services/tasks";
import { createRoom as createRoomInProperty, updateRoom } from "../lib/services/rooms";
import { buildInvestorReport } from "../lib/services/investor-report";
import { setPropertyActive, updateProperty, type UpdatePropertyInput } from "../lib/services/properties";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const invB: SessionUser = { id: "u-inv-b", name: "NĐT B", role: "INVESTOR" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };
const hk: SessionUser = { id: "u-hk", name: "Buồng phòng", role: "HOUSEKEEPER" };
const mgr: SessionUser = { id: "u-mgr", name: "Quản lý", role: "MANAGER" };

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
    { id: "inv-a", name: "NĐT A", userId: invA.id, dayladauHostId: "HOST-A", dayladauTokenEncrypted: "tok-a" },
    { id: "inv-b", name: "NĐT B", userId: invB.id },
  ]);
  await db.insert(s.properties).values([
    { id: "X", investorId: "inv-a", name: "Vạn Phúc", investmentAmount: 600_000_000, investmentStartMonth: "2026-07" },
    { id: "Y", investorId: "inv-a", name: "Phan Kế Bính" },
    { id: "Z", investorId: "inv-b", name: "Nguyễn Tư Giản" },
  ]);
  await db.insert(s.rooms).values([
    { id: "X1", propertyId: "X", name: "P101", openedOn: "2026-01-01", dayladauRoomId: "DR-X1" },
    { id: "Y1", propertyId: "Y", name: "P101", openedOn: "2026-01-01", dayladauRoomId: "DR-Y1" },
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
    await createExpense(db, acc, { propertyId: "X", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-05", amount: 10_000_000, description: "Thuê nhà X" });
    await createExpense(db, acc, { propertyId: "Y", categoryId: "rent", month: "2026-08", incurredOn: "2026-08-05", amount: 6_000_000, description: "Thuê nhà Y" });
    await setCommonFinalized(db, acc, "2026-08", true);
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

  it("chỉ Admin được lưu host ID và token", async () => {
    await expect(saveInvestorConnection(db, acc, { name: "X", hostId: "abc123", token: "t".repeat(20) }, enc)).rejects.toMatchObject({ status: 403 });
  });

  it("lưu token dạng mã hóa, không trả token ra ngoài", async () => {
    const c = await saveInvestorConnection(db, admin, { id: "inv-b", name: "NĐT B", hostId: "host-b-01", token: "secret-token-bbbbbbbbbbbb1234" }, enc);
    expect(c).toMatchObject({ hostId: "host-b-01", hasToken: true, tokenHint: "…1234" });
    expect(JSON.stringify(c)).not.toContain("secret-token");
    const [row] = await db.select().from(schema.investors).where(eq(schema.investors.id, "inv-b"));
    expect(row.dayladauTokenEncrypted).toBe("enc:secret-token-bbbbbbbbbbbb1234");
    // Sửa tên, để trống token → giữ token cũ
    await saveInvestorConnection(db, admin, { id: "inv-b", name: "NĐT B mới", hostId: "host-b-01" }, enc);
    const [row2] = await db.select().from(schema.investors).where(eq(schema.investors.id, "inv-b"));
    expect(row2.dayladauTokenEncrypted).toBe("enc:secret-token-bbbbbbbbbbbb1234");
    const list = await listConnections(db, admin, dec);
    expect(list.find((i) => i.id === "inv-b")?.tokenHint).toBe("…1234");
  });

  it("chặn host ID trùng và token có ký tự lạ", async () => {
    await expect(saveInvestorConnection(db, admin, { name: "Mới", hostId: "host-b-01", token: "x".repeat(20) }, enc)).rejects.toThrow(/đã gắn/);
    await expect(saveInvestorConnection(db, admin, { name: "Mới", hostId: "host-new", token: "abc def ghi jkl mno" }, enc)).rejects.toThrow(/token/);
  });

  it("kiểm tra kết nối liệt kê listing và trạng thái; gắn listing rồi đồng bộ được", async () => {
    const orders = [
      { id: "B-1", total_billed: 1_000_000, status: "confirmed", listing: { id: 501, name: "NTG P101" }, reservation: { start_time: "2026-09-20", end_time: "2026-09-21" }, items: [{ amount: 1_000_000, commission_rates: [{ type: "host", rate: 0.8 }] }] },
      { id: "B-2", total_billed: 900_000, status: "canceled", listing: { id: 502, name: "NTG P102" }, reservation: { start_time: "2026-09-22", end_time: "2026-09-23" }, items: [] },
    ];
    const t = await testConnection(db, admin, "inv-b", { fetchPage: async () => orders, decrypt: dec });
    expect(t.ok).toBe(true);
    expect(t.listings.map((l) => [l.key, l.roomId])).toEqual([["501", null], ["502", null]]);
    expect(t.statuses).toEqual(expect.arrayContaining([{ status: "canceled", orders: 1, treatedAs: "CANCELLED" }]));
    expect(t.samples[0]).toMatchObject({ id: "B-1", hostAmount: 800_000 });
    expect(JSON.stringify(t)).not.toMatch(/fullname|phone/);

    await mapListingToRoom(db, admin, "inv-b", "501", "Z1");
    await expect(mapListingToRoom(db, admin, "inv-b", "502", "X1")).rejects.toThrow(/không thuộc/);
    await createRoom(db, admin, { propertyId: "Z", name: "P103", openedOn: "2026-01-01", listingKey: "503" });
    // Thiếu / sai cơ sở: báo lỗi nghiệp vụ, không để lọt lỗi khóa ngoại thành "Lỗi máy chủ"
    await expect(createRoom(db, admin, { propertyId: "", name: "P104", openedOn: "2026-01-01", listingKey: "504" })).rejects.toThrow(/Chọn cơ sở/);
    await expect(createRoom(db, admin, { propertyId: "khong-co", name: "P104", openedOn: "2026-01-01", listingKey: "504" })).rejects.toThrow(/cơ sở/);
    // Tạo phòng mới cho listing đang gắn phòng khác cùng nhà đầu tư: chuyển listing sang phòng mới
    const p104 = await createRoom(db, admin, { propertyId: "Z", name: "P104", openedOn: "2026-01-01", listingKey: "503" });
    const byListing = await db.select({ id: schema.rooms.id }).from(schema.rooms).where(eq(schema.rooms.dayladauRoomId, "503"));
    expect(byListing).toEqual([{ id: p104.id }]);

    const r = await syncBookings(db, { client: { listBookings: async () => orders }, today: "2026-09-30", decrypt: dec, investorIds: ["inv-b"] });
    expect(r.created).toBe(1);
    expect(r.skipped).toBe(1); // 502 chưa gắn phòng
    const [b] = await db.select().from(schema.bookings).where(eq(schema.bookings.externalId, "B-1"));
    expect(b).toMatchObject({ roomId: "Z1", netAmount: 800_000, commissionAmount: 200_000 });
  });

  it("kết nối lỗi trả thông báo, không ném lỗi", async () => {
    const t = await testConnection(db, admin, "inv-b", { fetchPage: async () => { throw new Error("Host ID hoặc access token không hợp lệ (HTTP 401)"); }, decrypt: dec });
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

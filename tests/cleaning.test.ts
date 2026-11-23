// Dọn phòng: checklist có ảnh bắt buộc, ca hỗ trợ, cảnh báo dọn ngay, sự cố, Daily report.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import { clockIn, createTask, generateCleaningTasks } from "../lib/services/tasks";
import { mapDayladauOrder, toInstant } from "../lib/dayladau/mapping";
import { myNotifications, notifyUsers, saveSubscription, type PushSender } from "../lib/services/notify";
import {
  cleaningBoard, cleaningCalendar, cleaningDailyReport, cleaningWeeklyReport, completeCleaning, computeCleaningAlerts, listIssues,
  assignIssue, reportIssue, resolveIssue, setChecklistPhoto, toggleChecklistItem, weekStart, closePassedCleaningTasks, isAutoClosed,
} from "../lib/services/cleaning";
import * as D from "../lib/domain";

let db: DB;
const mgr: SessionUser = { id: "m", name: "Quản lý", role: "MANAGER" };
const quan: SessionUser = { id: "quan", name: "Quân", role: "HOUSEKEEPER" };
const huong: SessionUser = { id: "huong", name: "Hương", role: "HOUSEKEEPER" };
const today = D.todayVN();
// 13:35 giờ VN hôm nay: khách đến 14:00 → còn 25 phút
const now = new Date(`${today}T13:35:00+07:00`);

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.users).values([
    { id: mgr.id, name: mgr.name, role: "MANAGER", passwordHash: "x" },
    { id: quan.id, name: quan.name, role: "HOUSEKEEPER", passwordHash: "x" },
    { id: huong.id, name: huong.name, role: "HOUSEKEEPER", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values({ id: "inv", name: "NĐT" });
  await db.insert(s.properties).values([{ id: "KT", investorId: "inv", name: "Khương Trung" }, { id: "LT", investorId: "inv", name: "Lạc Trung" }]);
  await db.insert(s.rooms).values([
    { id: "P203", propertyId: "KT", name: "P203", openedOn: "2026-01-01" },
    { id: "P102", propertyId: "KT", name: "P102", openedOn: "2026-01-01" },
    { id: "L1", propertyId: "LT", name: "L101", openedOn: "2026-01-01" },
  ]);
  await db.insert(s.userPropertyAccess).values([
    { userId: mgr.id, propertyId: "KT" }, { userId: mgr.id, propertyId: "LT" },
    { userId: quan.id, propertyId: "KT" }, { userId: huong.id, propertyId: "LT" },
  ]);
  // Khách mới vào P203 hôm nay
  await db.insert(s.bookings).values({ id: "b-in", source: "MANUAL", propertyId: "KT", roomId: "P203", channel: "Direct", checkIn: today, checkOut: D.addDays(today, 1), status: "CONFIRMED" });
});

const due = new Date(`${today}T12:00:00+07:00`);

describe("Dọn phòng", () => {
  let t203 = "";
  let t102 = "";

  it("bảng phòng: phòng chưa dọn mà khách đến trong 30 phút là Dọn ngay, xếp lên đầu", async () => {
    t102 = (await createTask(db, mgr, { propertyId: "KT", roomId: "P102", type: "CLEANING", title: "Dọn P102", assigneeId: quan.id, dueAt: due, recurrenceRule: null })).id;
    t203 = (await createTask(db, mgr, { propertyId: "KT", roomId: "P203", type: "CLEANING", title: "Dọn P203", assigneeId: quan.id, dueAt: due, recurrenceRule: null })).id;
    const board = await cleaningBoard(db, quan, "KT", today, now);
    expect(board.map((r) => [r.roomName, r.state])).toEqual([["P203", "urgent"], ["P102", "todo"]]);
    expect(board[0].minutesToCheckIn).toBe(25);
  });

  it("không hoàn thành được khi thiếu ảnh bắt buộc; chụp ảnh tự tick mục đó", async () => {
    const [cl] = await db.select().from(schema.checklistResults).where(eq(schema.checklistResults.taskId, t203));
    const items = cl.results as { item: string; needPhoto?: boolean }[];
    for (let i = 0; i < items.length; i++) if (!items[i].needPhoto) await toggleChecklistItem(db, quan, t203, i, true);
    await expect(completeCleaning(db, quan, t203)).rejects.toThrow(/4 việc chưa tick, 4 ảnh bắt buộc/);
    const photoIdx = items.map((r, i) => (r.needPhoto ? i : -1)).filter((i) => i >= 0);
    for (const i of photoIdx.slice(0, 3)) await setChecklistPhoto(db, quan, t203, i, `loci-photos/cleaning/${i}.jpg`);
    await expect(completeCleaning(db, quan, t203)).rejects.toThrow(/1 việc chưa tick, 1 ảnh bắt buộc/);
    await setChecklistPhoto(db, quan, t203, photoIdx[3], "loci-photos/cleaning/key.jpg");
    await completeCleaning(db, quan, t203);
    const [done] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, t203));
    expect(done.status).toBe("DONE");
    expect(done.completedById).toBe(quan.id);
    expect(done.photoUrls).toHaveLength(4);
  });

  it("ca hỗ trợ: Hương vào ca ở Khương Trung (không được giao) thì làm được việc dọn ở đó", async () => {
    await expect(cleaningBoard(db, huong, "KT", today, now)).rejects.toMatchObject({ status: 404 });
    await expect(toggleChecklistItem(db, huong, t102, 0, true)).rejects.toMatchObject({ status: 404 });
    const a = await clockIn(db, huong, { propertyId: "KT", photoUrl: "loci-photos/att.jpg" });
    expect(a.support).toBe(true);
    expect((await cleaningBoard(db, huong, "KT", today, now)).length).toBe(2);
    await toggleChecklistItem(db, huong, t102, 0, true);
    // Quản lý không vào ca hỗ trợ ở cơ sở ngoài quyền
    await expect(clockIn(db, mgr, { propertyId: "inv-none" })).rejects.toMatchObject({ status: 404 });
  });

  it("cảnh báo tự động: phòng sắp có khách chưa dọn; sự cố mở quá 24 giờ", async () => {
    // P203 đã xong → không còn phòng gấp; thêm phòng gấp mới ở P203 cho ngày mai thì không tính hôm nay
    let r = await computeCleaningAlerts(db, now);
    expect(r.active).toBe(0);
    await db.update(schema.tasks).set({ status: "IN_PROGRESS", completedAt: null }).where(eq(schema.tasks.id, t203));
    r = await computeCleaningAlerts(db, now);
    expect(r.opened).toBe(1);
    const open = await db.select().from(schema.alerts).where(and(eq(schema.alerts.type, "CLEANING_URGENT"), isNull(schema.alerts.resolvedAt)));
    expect(open[0].message).toMatch(/P203.*dọn ngay/);
    await db.update(schema.tasks).set({ status: "DONE", completedAt: now }).where(eq(schema.tasks.id, t203));
    await computeCleaningAlerts(db, now);
    expect((await db.select().from(schema.alerts).where(and(eq(schema.alerts.type, "CLEANING_URGENT"), isNull(schema.alerts.resolvedAt)))).length).toBe(0);
  });

  it("sự cố: báo, liệt kê số ngày mở, chỉ quản lý hoặc người được giao đóng được", async () => {
    await expect(reportIssue(db, quan, { propertyId: "LT", category: "KEY", description: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(reportIssue(db, quan, { propertyId: "KT", category: "BAD", description: "x" })).rejects.toThrow(/loại/);
    const i = await reportIssue(db, quan, { propertyId: "KT", roomId: "P203", category: "KEY", description: "Mất 1 chìa khoá" });
    await db.update(schema.facilityIssues).set({ reportedAt: new Date(now.getTime() - 7 * 86400_000) }).where(eq(schema.facilityIssues.id, i.id));
    const list = await listIssues(db, mgr, { openOnly: true }, now);
    expect(list[0]).toMatchObject({ roomName: "P203", ageDays: 7, reportedBy: "Quân" });
    const r = await computeCleaningAlerts(db, now);
    expect(r.opened).toBe(1);
    await expect(resolveIssue(db, quan, i.id, "")).rejects.toMatchObject({ status: 403 });
    await resolveIssue(db, mgr, i.id, "Đã làm chìa mới");
    expect((await listIssues(db, mgr, { openOnly: true }, now)).length).toBe(0);
  });

  it("Daily report: thiếu ảnh, hết ca còn phòng, ca hỗ trợ; buồng phòng không xem được", async () => {
    await expect(cleaningDailyReport(db, quan, today, {}, now)).rejects.toMatchObject({ status: 403 });
    // Quân vào rồi ra ca, P102 còn dở; Hương cũng ra ca
    await clockIn(db, quan, { propertyId: "KT", photoUrl: "loci-photos/q.jpg" });
    await db.update(schema.attendance).set({ checkOutAt: now }).where(eq(schema.attendance.propertyId, "KT"));
    // Một phòng cũ hoàn thành không có ảnh
    const old = await createTask(db, mgr, { propertyId: "LT", roomId: "L1", type: "CLEANING", title: "Dọn L101", assigneeId: huong.id, dueAt: due, recurrenceRule: null });
    await db.update(schema.tasks).set({ status: "DONE", completedAt: now, completedById: huong.id }).where(eq(schema.tasks.id, old.id));
    const r = await cleaningDailyReport(db, mgr, today, {}, now);
    const kt = r.rows.find((x) => x.propertyId === "KT")!;
    expect(kt).toMatchObject({ total: 2, done: 1, main: ["Quân"], support: ["Hương"], status: { label: "Hết ca, chưa xong" } });
    expect(r.alerts.map((a) => a.kind)).toEqual(expect.arrayContaining(["missing", "unfinished", "support"]));
    expect(r.totals).toMatchObject({ total: 3, done: 2, doneWithPhotos: 1, missingPhotos: 1, notFinished: 1 });
    const w = await cleaningWeeklyReport(db, mgr, today, now);
    expect(w.from).toBe(weekStart(today));
    expect(w.staff.find((s) => s.name === "Quân")).toMatchObject({ rooms: 1, photoPct: 100 });
    expect(w.staff.find((s) => s.name === "Hương")!.photoPct).toBe(0);
  });

  it("lịch tuần: trả phòng và khách đến kèm trạng thái dọn", async () => {
    const ev = await cleaningCalendar(db, quan, "KT", weekStart(today), now);
    expect(ev.some((e) => e.kind === "IN" && e.roomName === "P203" && e.date === today)).toBe(true);
  });
});

const vn = (hm: string, d = today) => new Date(`${d}T${hm}:00+07:00`);

describe("Giờ nhận / trả phòng thật từ Dayladau", () => {
  it("đọc giờ từ reservation.start_time / end_time; chỉ có ngày thì không đoán giờ", () => {
    expect(toInstant("2026-09-29T14:30:00+07:00")?.toISOString()).toBe("2026-09-29T07:30:00.000Z");
    expect(toInstant("2026-09-29 09:15:00")?.toISOString()).toBe("2026-09-29T02:15:00.000Z");
    expect(toInstant(1790000000000)?.getTime()).toBe(1790000000000);
    expect(toInstant("1790000000")?.getTime()).toBe(1790000000000);
    expect(toInstant("2026-09-29")).toBeNull();
    const m = mapDayladauOrder({ id: 9, listing: { id: 1, name: "x" }, status: "confirmed", reservation: { start_time: "2026-09-29T09:00:00+07:00", end_time: "2026-09-29T13:00:00+07:00" } });
    expect([m.checkIn, m.checkOut, m.checkInAt?.toISOString(), m.checkOutAt?.toISOString()]).toEqual(["2026-09-29", "2026-09-30", "2026-09-29T02:00:00.000Z", "2026-09-29T06:00:00.000Z"]);
  });

  it("bảng phòng dùng giờ khách đến thật; thuê giờ trả trong ngày vẫn sinh việc dọn với hạn là giờ khách kế tiếp", async () => {
    const s = schema;
    await db.insert(s.rooms).values({ id: "P401", propertyId: "KT", name: "P401", openedOn: "2026-01-01" });
    // Khách thuê giờ 09:00–13:00 (cột ngày trả là hôm sau theo cách ghi đêm), khách kế tiếp đến 13:50
    await db.insert(s.bookings).values([
      { id: "h-out", source: "DAYLADAU", propertyId: "KT", roomId: "P401", channel: "Direct", guestName: "Khách giờ", checkIn: today, checkOut: D.addDays(today, 1), checkInAt: vn("09:00"), checkOutAt: vn("13:00"), status: "CONFIRMED" },
      { id: "h-in", source: "DAYLADAU", propertyId: "KT", roomId: "P401", channel: "Direct", guestName: "Lan Anh", checkIn: today, checkOut: D.addDays(today, 1), checkInAt: vn("13:50"), checkOutAt: vn("12:00", D.addDays(today, 1)), status: "CONFIRMED" },
    ]);
    expect(await generateCleaningTasks(db, today, today)).toBeGreaterThanOrEqual(1);
    const [t] = await db.select().from(s.tasks).where(eq(s.tasks.bookingId, "h-out"));
    expect(t.dueAt.toISOString()).toBe(vn("13:50").toISOString());
    const room = (await cleaningBoard(db, mgr, "KT", today, vn("13:30"))).find((r) => r.taskId === t.id)!;
    expect(room).toMatchObject({ state: "urgent", minutesToCheckIn: 20, nextGuest: "Lan Anh" });
    expect(room.checkoutAt?.toISOString()).toBe(vn("13:00").toISOString());
    // Khách đến lúc 13:50 thì 13:00 chưa gấp (còn 50 phút)
    expect((await cleaningBoard(db, mgr, "KT", today, vn("13:00"))).find((r) => r.taskId === t.id)!.state).toBe("todo");
  });
});

describe("Thông báo tới tài khoản nhân viên dọn dẹp", () => {
  const sent: string[] = [];
  const fake: PushSender = async (target, payload) => { if (target.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 }); sent.push(`${target.endpoint}|${JSON.parse(payload).title}`); };

  it("phòng cần dọn ngay: đẩy tới nhân viên chính của cơ sở, không gửi lặp, không gửi người ca hỗ trợ", async () => {
    await saveSubscription(db, quan, { endpoint: "https://push.example/quan", keys: { p256dh: "k", auth: "a" } }, "Android");
    await saveSubscription(db, huong, { endpoint: "https://push.example/huong", keys: { p256dh: "k", auth: "a" } }, "iPhone");
    await expect(saveSubscription(db, quan, { endpoint: "http://bad" }, null)).rejects.toThrow(/không hợp lệ/);
    const r = await computeCleaningAlerts(db, vn("13:30"), fake);
    expect(r.pushed).toBeGreaterThanOrEqual(1);
    expect(sent.some((x) => x.startsWith("https://push.example/quan|Dọn ngay P401"))).toBe(true);
    expect(sent.some((x) => x.startsWith("https://push.example/huong"))).toBe(false); // Hương chỉ sang hỗ trợ, không phải nhân viên chính KT
    const before = sent.length;
    await computeCleaningAlerts(db, vn("13:35"), fake);
    expect(sent.length).toBe(before);
    const inbox = await myNotifications(db, quan, { unreadOnly: true });
    expect(inbox.find((n) => n.title.startsWith("Dọn ngay P401"))).toMatchObject({ urgent: true, url: expect.stringMatching(/^\/don-dep\//) });
  });

  it("máy đã gỡ đăng ký (410) thì xóa; giao sự cố thì báo cho người được giao", async () => {
    await saveSubscription(db, quan, { endpoint: "https://push.example/gone", keys: { p256dh: "k", auth: "a" } }, null);
    await notifyUsers(db, [quan.id], { key: "T1", title: "Thử", body: "x" }, fake);
    expect((await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, "https://push.example/gone"))).length).toBe(0);
    const i = await reportIssue(db, quan, { propertyId: "KT", category: "SUPPLY", description: "Hết khăn tắm" });
    await assignIssue(db, mgr, i.id, quan.id, fake);
    expect(sent.at(-1)).toMatch(/quan\|Bạn được giao xử lý sự cố/);
  });
});

describe("Việc dọn tồn cũ không thành Dọn ngay", () => {
  it("việc mở từ nhiều ngày trước không hiện và không cảnh báo; khách đến quá 2 giờ thì không đẩy nữa", async () => {
    const s = schema;
    await db.insert(s.rooms).values({ id: "P501", propertyId: "KT", name: "P501", openedOn: "2026-01-01" });
    await db.insert(s.bookings).values({ id: "old-in", source: "DAYLADAU", propertyId: "KT", roomId: "P501", channel: "Direct", guestName: "Khách nay", checkIn: today, checkOut: D.addDays(today, 1), checkInAt: vn("10:00"), checkOutAt: vn("12:00", D.addDays(today, 1)), status: "CONFIRMED" });
    // Việc dọn từ 40 ngày trước chưa ai đóng
    const old = await createTask(db, mgr, { propertyId: "KT", roomId: "P501", type: "CLEANING", title: "Dọn P501 cũ", assigneeId: quan.id, dueAt: vn("12:00", D.addDays(today, -40)), recurrenceRule: null });
    expect((await cleaningBoard(db, mgr, "KT", today, vn("09:50"))).some((r) => r.taskId === old.id)).toBe(false);
    // Việc của hôm qua còn dở thì vẫn mang sang và cảnh báo khi khách sắp đến
    const y = await createTask(db, mgr, { propertyId: "KT", roomId: "P501", type: "CLEANING", title: "Dọn P501 hôm qua", assigneeId: quan.id, dueAt: vn("12:00", D.addDays(today, -1)), recurrenceRule: null });
    const room = (await cleaningBoard(db, mgr, "KT", today, vn("09:50"))).find((r) => r.taskId === y.id);
    expect(room?.state).toBe("urgent");
    // 3 giờ sau khi khách đến: vẫn hiện "Dọn ngay" trên bảng nhưng không đẩy thông báo mới
    const sent: string[] = [];
    await computeCleaningAlerts(db, vn("13:05"), async (_t, p) => { sent.push(JSON.parse(p).title); });
    expect(sent.some((t) => t.includes("P501"))).toBe(false);
  });
});

describe("Lark đang tắt", () => {
  it("không gửi nhắc duyệt chi phí, không gọi webhook khi chưa đặt LARK_ENABLED=1", async () => {
    const { notifyPendingExpenses } = await import("../lib/services/expense-notify");
    const { notifyLark, postLark, larkEnabled } = await import("../lib/services/settings");
    expect(larkEnabled()).toBe(false);
    const realFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response("{}"); }) as typeof fetch;
    try {
      await db.insert(schema.settings).values({ key: "larkWebhookUrl", value: "https://open.larksuite.com/open-apis/bot/v2/hook/x" }).onConflictDoNothing();
      expect(await notifyPendingExpenses(db, ["x"], "https://www.baocaodau.com")).toEqual({ sent: 0, skipped: 0, disabled: true });
      await notifyLark(db, "thử");
      expect(await postLark("https://open.larksuite.com/open-apis/bot/v2/hook/x", {})).toBe(false);
      expect(called).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("Nhiều lượt dọn trong ngày (thuê giờ + qua đêm) – tình huống phòng 301", () => {
  it("mỗi lượt khách trả ghép đúng với khách vào kế tiếp; việc hôm qua đã có khách mới thì không mang sang", async () => {
    const s = schema;
    const y = D.addDays(today, -1);
    const tmr = D.addDays(today, 1);
    await db.insert(s.rooms).values({ id: "R301", propertyId: "KT", name: "301", openedOn: "2026-01-01" });
    const bk = (id: string, guest: string, inAt: Date, outAt: Date, checkIn: string, checkOut: string) =>
      ({ id, source: "DAYLADAU" as const, propertyId: "KT", roomId: "R301", channel: "Airbnb", guestName: guest, checkIn, checkOut, checkInAt: inAt, checkOutAt: outAt, status: "CONFIRMED" as const });
    await db.insert(s.bookings).values([
      bk("g9006", "Khách 9006", vn("10:00", y), vn("20:00", y), y, today), // thuê giờ hôm qua (cột ngày trả ghi hôm nay)
      bk("g5818", "Khách 5818", vn("21:00", y), vn("09:00"), y, today),
      bk("gIris", "Iris", vn("10:00"), vn("20:00"), today, tmr),
      bk("gViet", "Việt Anh", vn("21:00"), vn("09:00", tmr), today, tmr),
    ]);
    // Việc cũ sinh theo cột ngày trả (cách cũ): Khách 9006 bị xếp vào hôm nay lúc 14:00
    await createTask(db, mgr, { propertyId: "KT", roomId: "R301", type: "CLEANING", title: "Dọn 301 – Khách 9006", assigneeId: quan.id, dueAt: vn("14:00"), recurrenceRule: null })
      .then((t) => db.update(s.tasks).set({ bookingId: "g9006" }).where(eq(s.tasks.id, t.id)));
    await generateCleaningTasks(db, today, today);
    const board = (await cleaningBoard(db, mgr, "KT", today, vn("10:18"))).filter((r) => r.roomId === "R301");
    expect(board.map((r) => [hm(r.checkoutAt), hm(r.nextCheckInAt), r.nextGuest, r.state])).toEqual([
      ["09:00", "10:00", "Iris", "urgent"], // khách vào 10:00, đã quá 18 phút
      ["20:00", "21:00", "Việt Anh", "todo"],
    ]);
    // 13:00: lượt 09:00→10:00 đã quá giờ khách vào hơn 2 tiếng → tách thành "Quá giờ", không còn là Dọn ngay
    const later = (await cleaningBoard(db, mgr, "KT", today, vn("13:00"))).filter((r) => r.roomId === "R301");
    expect(later.map((r) => r.state)).toEqual(["todo", "missed"]);
  });
});

describe("Tự đóng việc dọn đã qua lượt", () => {
  it("đóng việc hôm qua mà khách mới đã vào; giữ việc hôm qua khách chưa đến; Daily report ngày cũ vẫn thấy Quá giờ", async () => {
    const s = schema;
    const y = D.addDays(today, -1);
    await db.insert(s.rooms).values([
      { id: "A1", propertyId: "LT", name: "A1", openedOn: "2026-01-01" },
      { id: "A2", propertyId: "LT", name: "A2", openedOn: "2026-01-01" },
    ]);
    await db.insert(s.bookings).values([
      { id: "a1-out", source: "DAYLADAU", propertyId: "LT", roomId: "A1", channel: "Airbnb", guestName: "Cũ A1", checkIn: D.addDays(y, -1), checkOut: y, checkInAt: vn("14:00", D.addDays(y, -1)), checkOutAt: vn("09:00", y), status: "CONFIRMED" },
      { id: "a1-in", source: "DAYLADAU", propertyId: "LT", roomId: "A1", channel: "Airbnb", guestName: "Mới A1", checkIn: y, checkOut: D.addDays(today, 2), checkInAt: vn("21:00", y), checkOutAt: vn("12:00", D.addDays(today, 2)), status: "CONFIRMED" },
      { id: "a2-out", source: "DAYLADAU", propertyId: "LT", roomId: "A2", channel: "Airbnb", guestName: "Cũ A2", checkIn: D.addDays(y, -1), checkOut: y, checkInAt: vn("14:00", D.addDays(y, -1)), checkOutAt: vn("09:00", y), status: "CONFIRMED" },
    ]);
    const mk = (room: string, booking: string) => createTask(db, mgr, { propertyId: "LT", roomId: room, type: "CLEANING", title: `Dọn ${room}`, assigneeId: huong.id, dueAt: vn("18:00", y), recurrenceRule: null })
      .then(async (t) => { await db.update(s.tasks).set({ bookingId: booking }).where(eq(s.tasks.id, t.id)); return t.id; });
    const passed = await mk("A1", "a1-out");
    const pending = await mk("A2", "a2-out");
    const old = await createTask(db, mgr, { propertyId: "LT", roomId: "A2", type: "CLEANING", title: "Dọn A2 cũ", assigneeId: huong.id, dueAt: vn("12:00", D.addDays(today, -10)), recurrenceRule: null });

    expect(await closePassedCleaningTasks(db, today)).toBeGreaterThanOrEqual(2); // kể cả việc cũ của các test trước
    const get = async (id: string) => (await db.select().from(s.tasks).where(eq(s.tasks.id, id)))[0];
    expect(isAutoClosed(await get(passed))).toBe(true);
    expect(isAutoClosed(await get(old.id))).toBe(true);
    expect((await get(pending)).status).toBe("TODO"); // khách mới chưa vào A2: vẫn phải dọn, vẫn mang sang hôm nay
    expect((await cleaningBoard(db, mgr, "LT", today, vn("08:00"))).map((r) => r.taskId)).toContain(pending);
    expect((await cleaningBoard(db, mgr, "LT", today, vn("08:00"))).map((r) => r.taskId)).not.toContain(passed);
    // Xem lại Daily report hôm qua: lượt A1 vẫn hiện là Quá giờ, không biến mất
    const rep = await cleaningDailyReport(db, mgr, y, { propertyId: "LT" }, vn("08:00"));
    expect(rep.alerts.some((a) => a.kind === "missed" && a.detail.includes("A1"))).toBe(true);
    // Chạy lại không đóng thêm
    expect(await closePassedCleaningTasks(db, today)).toBe(0);
  });
});

function hm(d: Date | null) {
  return d ? new Date(d.getTime() + 7 * 3600_000).toISOString().slice(11, 16) : null;
}

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
  assignIssue, reportIssue, resolveIssue, setChecklistPhoto, toggleChecklistItem, weekStart,
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

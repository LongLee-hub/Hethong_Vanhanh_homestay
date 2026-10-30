// Công việc, checklist, chấm công (Đặc tả 7.5, 7.6).
import { and, asc, eq, gte, inArray, lte, or } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { attendance, bookings, checklistResults, rooms, tasks, userPropertyAccess, users } from "../db/schema";
import { allowedPropertyIds, assertPropertyAccess, badRequest, can, forbidden, notFound, requirePermission, type SessionUser } from "../auth/access";
import { getSetting } from "./settings";

export const DEFAULT_CHECKLIST = [
  "Thay ga, vỏ gối, khăn tắm",
  "Hút bụi, lau sàn",
  "Vệ sinh nhà tắm, bồn cầu",
  "Bổ sung nước, trà, đồ vệ sinh cá nhân",
  "Kiểm tra điều hòa, đèn, remote",
  "Đổ rác, thay túi rác",
  "Chụp ảnh phòng sau khi dọn",
];

type TaskInsert = typeof tasks.$inferInsert;

export async function listTasks(db: DB, user: SessionUser, opts: { from?: Date; to?: Date } = {}) {
  requirePermission(user, "workTask");
  const pids = await allowedPropertyIds(db, user);
  if (!pids.length) return [];
  const conds = [inArray(tasks.propertyId, pids)];
  if (user.role === "HOUSEKEEPER") conds.push(eq(tasks.assigneeId, user.id));
  if (opts.from) conds.push(gte(tasks.dueAt, opts.from));
  if (opts.to) conds.push(lte(tasks.dueAt, opts.to));
  return db.select().from(tasks).where(and(...conds)).orderBy(asc(tasks.dueAt));
}

export async function createTask(db: DB, user: SessionUser, input: Omit<TaskInsert, "id" | "assignedById" | "status">) {
  requirePermission(user, "assignTask");
  await assertPropertyAccess(db, user, input.propertyId);
  if (!input.title?.trim()) throw badRequest("Nhập tên việc");
  if (input.assigneeId) {
    const [a] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .leftJoin(userPropertyAccess, and(eq(userPropertyAccess.userId, users.id), eq(userPropertyAccess.propertyId, input.propertyId)))
      .where(and(eq(users.id, input.assigneeId), or(eq(users.role, "ADMIN"), eq(userPropertyAccess.propertyId, input.propertyId))))
      .limit(1);
    if (!a) throw badRequest("Người làm không được gán cơ sở này");
  }
  const [t] = await db.insert(tasks).values({ ...input, assignedById: user.id, status: "TODO" }).returning();
  if (t.type === "CLEANING") await db.insert(checklistResults).values({ taskId: t.id, results: DEFAULT_CHECKLIST.map((item) => ({ item, done: false })) });
  return t;
}

async function loadTaskForWork(db: DB, user: SessionUser, id: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) throw notFound("Không tìm thấy việc");
  await assertPropertyAccess(db, user, t.propertyId);
  if (!can(user, "assignTask") && t.assigneeId !== user.id) throw forbidden("Việc này không giao cho bạn");
  return t;
}

export async function updateChecklist(db: DB, user: SessionUser, taskId: string, results: { item: string; done: boolean; note?: string }[]) {
  const t = await loadTaskForWork(db, user, taskId);
  if (t.status === "DONE") throw badRequest("Việc đã hoàn thành");
  await db.insert(checklistResults).values({ taskId, results }).onConflictDoUpdate({ target: checklistResults.taskId, set: { results } });
  if (t.status === "TODO") await db.update(tasks).set({ status: "IN_PROGRESS" }).where(eq(tasks.id, taskId));
}

export async function addTaskPhoto(db: DB, user: SessionUser, taskId: string, url: string) {
  const t = await loadTaskForWork(db, user, taskId);
  await db.update(tasks).set({ photoUrls: [...t.photoUrls, url] }).where(eq(tasks.id, taskId));
}

export async function setTaskStatus(db: DB, user: SessionUser, taskId: string, status: "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED") {
  const t = await loadTaskForWork(db, user, taskId);
  if (status === "CANCELLED" && !can(user, "assignTask")) throw forbidden("Chỉ người giao việc được hủy");
  if (status === "DONE") {
    if (["CLEANING", "MAINTENANCE"].includes(t.type) && !t.photoUrls.length) throw badRequest("Cần ít nhất một ảnh nghiệm thu trước khi hoàn thành");
    const [cl] = await db.select().from(checklistResults).where(eq(checklistResults.taskId, taskId)).limit(1);
    if (cl && (cl.results as { done: boolean }[]).some((r) => !r.done)) throw badRequest("Tick đủ các mục checklist trước khi hoàn thành");
  }
  await db.update(tasks).set({ status, completedAt: status === "DONE" ? new Date() : null }).where(eq(tasks.id, taskId));
  // Việc định kỳ: hoàn thành thì sinh lần kế tiếp
  if (status === "DONE" && t.recurrenceRule?.startsWith("monthly:")) {
    const dueVN = new Date(t.dueAt.getTime() + 7 * 3600_000).toISOString();
    const nm = D.nextMonth(dueVN.slice(0, 7));
    const day = Math.min(Number(t.recurrenceRule.split(":")[1]), D.daysInMonth(nm));
    const next = new Date(`${nm}-${String(day).padStart(2, "0")}T${dueVN.slice(11, 19)}+07:00`);
    const { id: _id, completedAt: _c, photoUrls: _p, status: _s, ...rest } = t;
    await db.insert(tasks).values({ ...rest, dueAt: next, status: "TODO", photoUrls: [] });
  }
}

/** Sinh việc dọn phòng cho các đơn check-out trong khoảng ngày (job hằng ngày). TODO(CONFIRM): quy tắc hạn chót. */
export async function generateCleaningTasks(db: DB, fromDate: string, toDate: string, createdBy = "SYSTEM") {
  const hour = await getSetting(db, "cleaningDueHour");
  const outs = await db.select().from(bookings).where(and(eq(bookings.status, "CONFIRMED"), gte(bookings.checkOut, fromDate), lte(bookings.checkOut, toDate)));
  if (!outs.length) return 0;
  const existing = new Set(
    (await db.select({ b: tasks.bookingId }).from(tasks).where(and(eq(tasks.type, "CLEANING"), inArray(tasks.bookingId, outs.map((b) => b.id))))).map((r) => r.b),
  );
  let n = 0;
  for (const b of outs) {
    if (existing.has(b.id)) continue;
    const [room] = await db.select().from(rooms).where(eq(rooms.id, b.roomId)).limit(1);
    const [hk] = await db
      .select({ id: users.id })
      .from(users)
      .innerJoin(userPropertyAccess, eq(userPropertyAccess.userId, users.id))
      .where(and(eq(users.role, "HOUSEKEEPER"), eq(users.active, true), eq(userPropertyAccess.propertyId, b.propertyId)))
      .limit(1);
    const [t] = await db
      .insert(tasks)
      .values({
        propertyId: b.propertyId, roomId: b.roomId, bookingId: b.id, type: "CLEANING", title: `Dọn ${room?.name ?? "phòng"} sau check-out – ${b.guestName ?? "khách"}`,
        assignedById: createdBy, assigneeId: hk?.id ?? null, dueAt: new Date(`${b.checkOut}T${hour}:00+07:00`), status: "TODO",
      })
      .returning();
    await db.insert(checklistResults).values({ taskId: t.id, results: DEFAULT_CHECKLIST.map((item) => ({ item, done: false })) });
    n++;
  }
  return n;
}

// ---- Chấm công ----
export async function clockIn(db: DB, user: SessionUser, propertyId: string, photoUrl?: string) {
  requirePermission(user, "clock");
  await assertPropertyAccess(db, user, propertyId);
  const today = D.todayVN();
  const [ex] = await db.select().from(attendance).where(and(eq(attendance.userId, user.id), eq(attendance.date, today))).limit(1);
  if (ex) throw badRequest("Hôm nay đã vào ca");
  const [row] = await db.insert(attendance).values({ userId: user.id, propertyId, date: today, checkInAt: new Date(), photoUrl }).returning();
  return row;
}

export async function clockOut(db: DB, user: SessionUser) {
  requirePermission(user, "clock");
  const today = D.todayVN();
  const [ex] = await db.select().from(attendance).where(and(eq(attendance.userId, user.id), eq(attendance.date, today))).limit(1);
  if (!ex) throw badRequest("Chưa vào ca hôm nay");
  if (ex.checkOutAt) throw badRequest("Đã ra ca");
  await db.update(attendance).set({ checkOutAt: new Date() }).where(eq(attendance.id, ex.id));
}

export async function attendanceForMonth(db: DB, user: SessionUser, month: string) {
  const conds = [gte(attendance.date, D.firstDay(month)), lte(attendance.date, D.lastDay(month))];
  if (!can(user, "viewAllAttendance")) conds.push(eq(attendance.userId, user.id));
  else conds.push(inArray(attendance.propertyId, (await allowedPropertyIds(db, user)).concat("__none")));
  return db.select().from(attendance).where(and(...conds));
}

// ---- Xử lý đánh giá xấu ----
/** Hạn xử lý đánh giá xấu: trả lời khách và tìm nguyên nhân trong chừng này ngày. */
export const BAD_REVIEW_DUE_DAYS = 2;

/**
 * Việc "Xử lý đánh giá" cho đánh giá thấp mới về (gọi từ đồng bộ review, mỗi review một lần).
 * Giao cho quản lý cơ sở đang hoạt động; chưa có quản lý thì để trống người làm cho Admin giao.
 * Gắn với đơn đặt phòng nếu tìm được đúng một đơn cùng phòng (hoặc cơ sở) và ngày trả phòng.
 */
export async function createBadReviewTask(
  db: DB,
  r: { propertyId: string; roomId: string | null; checkOut: string | null; title: string; description: string },
  today = D.todayVN(),
  createdBy = "SYSTEM",
) {
  const [mgr] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userPropertyAccess, eq(userPropertyAccess.userId, users.id))
    .where(and(eq(users.role, "MANAGER"), eq(users.active, true), eq(userPropertyAccess.propertyId, r.propertyId)))
    .orderBy(asc(users.name))
    .limit(1);
  let bookingId: string | null = null;
  if (r.checkOut) {
    const cands = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(eq(bookings.propertyId, r.propertyId), eq(bookings.checkOut, r.checkOut), eq(bookings.status, "CONFIRMED"), r.roomId ? eq(bookings.roomId, r.roomId) : undefined));
    if (cands.length === 1) bookingId = cands[0].id;
  }
  const [t] = await db
    .insert(tasks)
    .values({
      propertyId: r.propertyId, roomId: r.roomId, bookingId, type: "BAD_REVIEW", title: r.title, description: r.description,
      assignedById: createdBy, assigneeId: mgr?.id ?? null, dueAt: new Date(`${D.addDays(today, BAD_REVIEW_DUE_DAYS)}T18:00:00+07:00`),
      priority: "HIGH", status: "TODO",
    })
    .returning({ id: tasks.id });
  return t.id;
}

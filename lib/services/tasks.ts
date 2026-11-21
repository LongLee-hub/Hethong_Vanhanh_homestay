// Công việc, checklist, chấm công (Đặc tả 7.5, 7.6).
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { attendance, bookings, checklistResults, properties, rooms, tasks, userPropertyAccess, users } from "../db/schema";
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

/** Một mục checklist. needPhoto: mục bắt buộc có ảnh; photo: ảnh đã chụp cho mục đó (dạng "bucket/đường-dẫn"). */
export interface ChecklistItem {
  item: string;
  done: boolean;
  note?: string;
  needPhoto?: boolean;
  photo?: string | null;
}

/**
 * Checklist dọn phòng. Các mục có máy ảnh bắt buộc chụp, thiếu ảnh thì không hoàn thành được:
 * quản lý xem lại được từng phòng, kể cả chìa khoá/thẻ từ (sự cố mất chìa khoá phát hiện ngay trong ca).
 */
export const CLEANING_CHECKLIST: ChecklistItem[] = [
  { item: "Thay ga, vỏ gối, khăn tắm", done: false, needPhoto: true },
  { item: "Vệ sinh nhà tắm, bồn cầu", done: false, needPhoto: true },
  { item: "Hút bụi, lau sàn", done: false, needPhoto: true },
  { item: "Bổ sung nước, trà, đồ vệ sinh cá nhân", done: false },
  { item: "Kiểm tra điều hòa, đèn, remote", done: false },
  { item: "Đổ rác, thay túi rác", done: false },
  { item: "Kiểm tra chìa khoá / thẻ từ đủ và đúng chỗ", done: false, needPhoto: true },
];

/** Checklist mới cho việc vừa tạo: dọn phòng dùng checklist có ảnh, loại khác dùng danh sách cũ. */
export const newChecklist = (type: string): ChecklistItem[] =>
  type === "CLEANING" ? CLEANING_CHECKLIST.map((c) => ({ ...c })) : DEFAULT_CHECKLIST.map((item) => ({ item, done: false }));

/**
 * Lý do chưa hoàn thành được (null = đủ điều kiện). Checklist có mục bắt buộc ảnh thì mỗi mục đó phải có ảnh riêng;
 * checklist cũ (không đánh dấu mục ảnh) giữ quy tắc cũ: dọn phòng/bảo trì cần ít nhất một ảnh nghiệm thu.
 */
export function completionBlocker(type: string, photoUrls: string[], results: ChecklistItem[] | null | undefined): string | null {
  const list = results ?? [];
  const missingTicks = list.filter((r) => !r.done).length;
  const photoItems = list.filter((r) => r.needPhoto);
  if (photoItems.length) {
    const missingPhotos = photoItems.filter((r) => !r.photo).length;
    if (!missingTicks && !missingPhotos) return null;
    return `Còn thiếu ${[missingTicks ? `${missingTicks} việc chưa tick` : "", missingPhotos ? `${missingPhotos} ảnh bắt buộc` : ""].filter(Boolean).join(", ")}`;
  }
  if (["CLEANING", "MAINTENANCE"].includes(type) && !photoUrls.length) return "Cần ít nhất một ảnh nghiệm thu trước khi hoàn thành";
  if (missingTicks) return "Tick đủ các mục checklist trước khi hoàn thành";
  return null;
}

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
  if (t.type === "CLEANING") await db.insert(checklistResults).values({ taskId: t.id, results: newChecklist(t.type) });
  return t;
}

/**
 * Buồng phòng đang có ca hôm nay tại cơ sở (ca chính hoặc ca hỗ trợ). Nhiều người cùng dọn một cơ sở,
 * hoặc người sang hỗ trợ, đều làm được việc dọn phòng của cơ sở đó dù việc giao cho người khác.
 */
export async function onShiftAt(db: DB, userId: string, propertyId: string, today = D.todayVN()) {
  const [a] = await db.select({ id: attendance.id }).from(attendance)
    .where(and(eq(attendance.userId, userId), eq(attendance.date, today), eq(attendance.propertyId, propertyId))).limit(1);
  return !!a;
}

export async function loadTaskForWork(db: DB, user: SessionUser, id: string) {
  const [t] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  if (!t) throw notFound("Không tìm thấy việc");
  if (can(user, "assignTask")) {
    await assertPropertyAccess(db, user, t.propertyId);
    return t;
  }
  if (t.assigneeId === user.id) {
    // Người được giao: cơ sở của mình, hoặc đang có ca hỗ trợ ở đó
    if (!(await allowedPropertyIds(db, user)).includes(t.propertyId) && !(await onShiftAt(db, user.id, t.propertyId))) throw notFound("Không tìm thấy việc");
    return t;
  }
  if (t.type === "CLEANING" && (await onShiftAt(db, user.id, t.propertyId))) return t;
  if (!(await allowedPropertyIds(db, user)).includes(t.propertyId)) throw notFound("Không tìm thấy việc");
  throw forbidden("Việc này không giao cho bạn");
}

export async function updateChecklist(db: DB, user: SessionUser, taskId: string, input: { item: string; done: boolean; note?: string }[]) {
  const t = await loadTaskForWork(db, user, taskId);
  if (t.status === "DONE") throw badRequest("Việc đã hoàn thành");
  // Giữ cờ bắt buộc ảnh và ảnh đã chụp của từng mục: form ở trang Công việc chỉ gửi tên mục và trạng thái tick
  const [cur] = await db.select().from(checklistResults).where(eq(checklistResults.taskId, taskId)).limit(1);
  const prev = new Map(((cur?.results ?? []) as ChecklistItem[]).map((r) => [r.item, r]));
  const results = input.map((r) => ({ ...prev.get(r.item), ...r }));
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
    const [cl] = await db.select().from(checklistResults).where(eq(checklistResults.taskId, taskId)).limit(1);
    const why = completionBlocker(t.type, t.photoUrls, cl?.results as ChecklistItem[] | undefined);
    if (why) throw badRequest(why);
  }
  const done = status === "DONE";
  await db.update(tasks).set({ status, completedAt: done ? new Date() : null, completedById: done ? user.id : null }).where(eq(tasks.id, taskId));
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

/**
 * Sinh việc dọn phòng cho các đơn trả phòng trong khoảng ngày (job hằng ngày).
 * Ngày trả phòng theo giờ thật từ Dayladau (thuê giờ trả trong ngày), không có giờ thì theo cột ngày.
 * Hạn dọn: giờ khách kế tiếp vào phòng đó trong ngày nếu sớm hơn giờ dọn chuẩn (cleaningDueHour);
 * khách trả phòng muộn hơn giờ chuẩn mà không có khách mới thì hạn là 2 giờ sau khi trả.
 */
export async function generateCleaningTasks(db: DB, fromDate: string, toDate: string, createdBy = "SYSTEM") {
  const [hour, inH, outH] = await Promise.all([getSetting(db, "cleaningDueHour"), getSetting(db, "checkInHour"), getSetting(db, "checkOutHour")]);
  const at = (d: string, hm: string) => new Date(`${d}T${hm}:00+07:00`);
  const vnDay = (d: Date) => new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const outs = await db.select().from(bookings).where(and(eq(bookings.status, "CONFIRMED"), or(
    and(gte(bookings.checkOutAt, at(fromDate, "00:00")), lt(bookings.checkOutAt, at(D.addDays(toDate, 1), "00:00"))),
    and(isNull(bookings.checkOutAt), gte(bookings.checkOut, fromDate), lte(bookings.checkOut, toDate)),
  )));
  if (!outs.length) return 0;
  const existing = new Set(
    (await db.select({ b: tasks.bookingId }).from(tasks).where(and(eq(tasks.type, "CLEANING"), inArray(tasks.bookingId, outs.map((b) => b.id))))).map((r) => r.b),
  );
  let n = 0;
  for (const b of outs) {
    if (existing.has(b.id)) continue;
    const leaveAt = b.checkOutAt ?? at(b.checkOut, outH || "12:00");
    const day = vnDay(leaveAt);
    const dayEnd = at(D.addDays(day, 1), "00:00");
    // Khách kế tiếp vào cùng phòng trong ngày, sau khi khách này trả phòng
    const nexts = await db.select({ checkIn: bookings.checkIn, checkInAt: bookings.checkInAt }).from(bookings).where(and(
      eq(bookings.roomId, b.roomId), eq(bookings.status, "CONFIRMED"), ne(bookings.id, b.id),
      or(and(gte(bookings.checkInAt, leaveAt), lt(bookings.checkInAt, dayEnd)), and(isNull(bookings.checkInAt), eq(bookings.checkIn, day))),
    ));
    const nextIn = nexts.map((x) => x.checkInAt ?? at(x.checkIn, inH || "14:00")).filter((t) => t >= leaveAt).sort((x, y) => x.getTime() - y.getTime())[0];
    const standard = at(day, hour || "14:00");
    let dueAt = nextIn && nextIn < standard ? nextIn : standard;
    if (dueAt < leaveAt) dueAt = nextIn ?? new Date(leaveAt.getTime() + 2 * 3600_000);
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
        assignedById: createdBy, assigneeId: hk?.id ?? null, dueAt, status: "TODO",
      })
      .returning();
    await db.insert(checklistResults).values({ taskId: t.id, results: newChecklist("CLEANING") });
    n++;
  }
  return n;
}

// ---- Chấm công ----
export interface ClockInInput {
  propertyId: string;
  /** Ca hỗ trợ: sang dọn cơ sở khác. Vào ca ở cơ sở không được giao thì luôn tính là ca hỗ trợ. */
  support?: boolean;
  shift?: "MORNING" | "EVENING" | "OVERTIME";
  photoUrl?: string;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  /** Địa chỉ in trên ảnh (tra từ GPS ở trình duyệt). */
  address?: string | null;
}

/** Vào ca. Buồng phòng bắt buộc có ảnh chụp tại chỗ (đã in ngày giờ, cơ sở, tọa độ). Mỗi người mỗi ngày mỗi ca một lần. */
export async function clockIn(db: DB, user: SessionUser, i: ClockInInput) {
  requirePermission(user, "clock");
  const shift = i.shift ?? "MORNING";
  let support = !!i.support;
  if (!(await allowedPropertyIds(db, user)).includes(i.propertyId)) {
    // Buồng phòng được vào ca hỗ trợ ở cơ sở đang hoạt động bất kỳ; vai trò khác chỉ chấm ở cơ sở được giao
    const [p] = user.role === "HOUSEKEEPER" ? await db.select({ id: properties.id }).from(properties).where(and(eq(properties.id, i.propertyId), eq(properties.active, true))).limit(1) : [];
    if (!p) throw notFound("Không tìm thấy cơ sở");
    support = true;
  }
  if (user.role === "HOUSEKEEPER" && !i.photoUrl) throw badRequest("Chụp ảnh tại cơ sở để vào ca");
  const today = D.todayVN();
  const [ex] = await db.select().from(attendance).where(and(eq(attendance.userId, user.id), eq(attendance.date, today), eq(attendance.shift, shift))).limit(1);
  if (ex) throw badRequest("Hôm nay đã vào ca này rồi");
  const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const [row] = await db
    .insert(attendance)
    .values({
      userId: user.id, propertyId: i.propertyId, date: today, shift, support, checkInAt: new Date(), photoUrl: i.photoUrl,
      lat: num(i.lat), lng: num(i.lng), accuracyM: num(i.accuracyM) === null ? null : Math.round(i.accuracyM!),
      checkInAddress: i.address?.trim().slice(0, 300) || null,
    })
    .returning();
  return row;
}

/**
 * Ra ca: ca đang mở gần nhất hôm nay (hoặc đúng ca được chỉ định).
 * Buồng phòng phải chụp ảnh kết thúc ca tại cơ sở (in giờ, vị trí như ảnh vào ca).
 */
export async function clockOut(
  db: DB, user: SessionUser,
  opts: { attendanceId?: string; photoUrl?: string; lat?: number | null; lng?: number | null; accuracyM?: number | null; address?: string | null } = {},
) {
  requirePermission(user, "clock");
  if (user.role === "HOUSEKEEPER" && !opts.photoUrl) throw badRequest("Chụp ảnh tại cơ sở để kết thúc ca");
  const today = D.todayVN();
  const open = (await db.select().from(attendance).where(and(eq(attendance.userId, user.id), eq(attendance.date, today))))
    .filter((r) => !r.checkOutAt && (!opts.attendanceId || r.id === opts.attendanceId))
    .sort((a, b) => b.checkInAt.getTime() - a.checkInAt.getTime());
  if (!open.length) throw badRequest("Không có ca nào đang mở hôm nay");
  const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const acc = num(opts.accuracyM);
  const [row] = await db.update(attendance).set({
    checkOutAt: new Date(), checkOutPhotoUrl: opts.photoUrl ?? null,
    checkOutLat: num(opts.lat), checkOutLng: num(opts.lng), checkOutAccuracyM: acc === null ? null : Math.round(acc),
    checkOutAddress: opts.address?.trim().slice(0, 300) || null,
  }).where(eq(attendance.id, open[0].id)).returning();
  return row;
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

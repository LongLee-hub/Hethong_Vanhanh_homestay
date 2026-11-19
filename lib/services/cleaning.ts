// Dọn phòng: bảng phòng cho buồng phòng, checklist có ảnh bắt buộc, lịch tuần, sự cố cơ sở vật chất,
// Daily report cho quản lý và cảnh báo (phòng sắp có khách mà chưa dọn, hết ca còn phòng, thiếu ảnh, sự cố để lâu).
import { and, asc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, or } from "drizzle-orm";
import * as D from "../domain";
import type { DB } from "../db";
import { alerts, attendance, bookings, checklistResults, facilityIssues, properties, rooms, tasks, users } from "../db/schema";
import { allowedPropertyIds, assertPropertyAccess, badRequest, can, forbidden, notFound, requirePermission, type SessionUser } from "../auth/access";
import { getSetting, notifyLark } from "./settings";
import { completionBlocker, loadTaskForWork, setTaskStatus, type ChecklistItem } from "./tasks";

const VN = 7 * 3600_000;
/** Giờ:phút theo giờ Việt Nam. */
export const hmVN = (d: Date) => new Date(d.getTime() + VN).toISOString().slice(11, 16);
/** Ngày (YYYY-MM-DD) theo giờ Việt Nam của một thời điểm. */
export const dayVN = (d: Date) => new Date(d.getTime() + VN).toISOString().slice(0, 10);
const at = (date: string, hm: string) => new Date(`${date}T${hm}:00+07:00`);

/** Phút trước giờ khách đến thì phòng chưa dọn xong bị báo "Dọn ngay". */
export async function urgentMinutes(db: DB) {
  const n = Number(await getSetting(db, "cleaning.urgentMinutes"));
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export type CleanState = "done" | "urgent" | "doing" | "todo";
export const STATE_LABEL: Record<CleanState, string> = { done: "Đã xong", urgent: "Dọn ngay", doing: "Đang dọn", todo: "Chưa dọn" };

export interface BoardRoom {
  taskId: string;
  roomId: string | null;
  roomName: string;
  title: string;
  state: CleanState;
  checkoutOn: string; // ngày hạn dọn (theo giờ VN)
  dueAt: Date;
  /** Giờ khách kế tiếp đến phòng này trong ngày; null = hôm nay chưa có khách mới. */
  nextCheckInAt: Date | null;
  minutesToCheckIn: number | null;
  ticks: number;
  total: number;
  photos: number;
  photoNeed: number;
  assigneeId: string | null;
  completedById: string | null;
  completedAt: Date | null;
  /** Hoàn thành nhưng thiếu ảnh bắt buộc (việc cũ trước khi có checklist ảnh, hoặc hoàn thành qua đường khác). */
  missingPhotos: boolean;
  checklist: ChecklistItem[];
  bookingId: string | null;
}

const checklistStats = (list: ChecklistItem[], photoUrls: string[]) => {
  const need = list.filter((r) => r.needPhoto);
  return {
    ticks: list.filter((r) => r.done).length,
    total: list.length,
    photoNeed: need.length,
    photos: need.length ? need.filter((r) => r.photo).length : photoUrls.length,
  };
};

/**
 * Các cơ sở người dùng làm được việc dọn phòng hôm nay: cơ sở được giao, cộng cơ sở đang có ca (kể cả ca hỗ trợ).
 */
export async function workablePropertyIds(db: DB, user: SessionUser, today = D.todayVN()) {
  const own = await allowedPropertyIds(db, user);
  const shifts = await db.select({ p: attendance.propertyId }).from(attendance).where(and(eq(attendance.userId, user.id), eq(attendance.date, today)));
  return [...new Set([...own, ...shifts.map((s) => s.p)])];
}

async function assertWorkable(db: DB, user: SessionUser, propertyId: string, today = D.todayVN()) {
  if (!(await workablePropertyIds(db, user, today)).includes(propertyId)) throw notFound("Không tìm thấy cơ sở");
}

/** Ca hôm nay của người dùng, ca đang mở (chưa ra ca) đứng trước. */
export async function myShiftsToday(db: DB, user: SessionUser, today = D.todayVN()) {
  const rows = await db.select().from(attendance).where(and(eq(attendance.userId, user.id), eq(attendance.date, today)));
  return rows.sort((a, b) => Number(!!a.checkOutAt) - Number(!!b.checkOutAt) || b.checkInAt.getTime() - a.checkInAt.getTime());
}

/**
 * Bảng phòng cần dọn của một cơ sở trong ngày: việc dọn có hạn trong ngày, cộng việc ngày trước còn dang dở.
 * Trạng thái "Dọn ngay" khi phòng chưa xong mà khách kế tiếp đến trong vòng `urgentMinutes` phút (hoặc đã quá giờ).
 */
export async function cleaningBoard(db: DB, user: SessionUser, propertyId: string, date = D.todayVN(), now = new Date()): Promise<BoardRoom[]> {
  requirePermission(user, "workTask");
  await assertWorkable(db, user, propertyId, D.todayVN(now));
  return boardFor(db, [propertyId], date, now).then((m) => m.get(propertyId) ?? []);
}

async function boardFor(db: DB, propertyIds: string[], date: string, now: Date): Promise<Map<string, BoardRoom[]>> {
  const out = new Map<string, BoardRoom[]>();
  if (!propertyIds.length) return out;
  const dayStart = at(date, "00:00");
  const dayEnd = at(D.addDays(date, 1), "00:00");
  const list = await db.select().from(tasks).where(and(
    inArray(tasks.propertyId, propertyIds), eq(tasks.type, "CLEANING"), ne(tasks.status, "CANCELLED"),
    or(and(gte(tasks.dueAt, dayStart), lt(tasks.dueAt, dayEnd)), and(lt(tasks.dueAt, dayStart), inArray(tasks.status, ["TODO", "IN_PROGRESS"]))),
  ));
  if (!list.length) return out;
  const [cls, rs, ins, checkInHour, urgent] = await Promise.all([
    db.select().from(checklistResults).where(inArray(checklistResults.taskId, list.map((t) => t.id))),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(inArray(rooms.propertyId, propertyIds)),
    db.select({ roomId: bookings.roomId, checkIn: bookings.checkIn }).from(bookings)
      .where(and(inArray(bookings.propertyId, propertyIds), eq(bookings.status, "CONFIRMED"), eq(bookings.checkIn, date))),
    getSetting(db, "checkInHour"),
    urgentMinutes(db),
  ]);
  const roomName = new Map(rs.map((r) => [r.id, r.name]));
  const incoming = new Set(ins.map((b) => b.roomId));
  for (const t of list) {
    const cl = (cls.find((c) => c.taskId === t.id)?.results ?? []) as ChecklistItem[];
    const st = checklistStats(cl, t.photoUrls);
    const nextIn = t.roomId && incoming.has(t.roomId) ? at(date, checkInHour || "14:00") : null;
    const mins = nextIn ? Math.round((nextIn.getTime() - now.getTime()) / 60_000) : null;
    const done = t.status === "DONE";
    const state: CleanState = done ? "done" : mins !== null && mins <= urgent ? "urgent" : st.ticks || (st.photoNeed && st.photos) ? "doing" : "todo";
    const room: BoardRoom = {
      taskId: t.id, roomId: t.roomId, roomName: (t.roomId && roomName.get(t.roomId)) || t.title, title: t.title, state,
      checkoutOn: dayVN(t.dueAt), dueAt: t.dueAt, nextCheckInAt: nextIn, minutesToCheckIn: mins, ...st,
      assigneeId: t.assigneeId, completedById: t.completedById, completedAt: t.completedAt,
      missingPhotos: done && (st.photoNeed ? st.photos < st.photoNeed : st.photos === 0), checklist: cl, bookingId: t.bookingId,
    };
    out.set(t.propertyId, [...(out.get(t.propertyId) ?? []), room]);
  }
  const rank: Record<CleanState, number> = { urgent: 0, doing: 1, todo: 2, done: 3 };
  for (const [k, v] of out) {
    out.set(k, v.sort((a, b) => rank[a.state] - rank[b.state]
      || (a.nextCheckInAt?.getTime() ?? Infinity) - (b.nextCheckInAt?.getTime() ?? Infinity)
      || a.roomName.localeCompare(b.roomName, "vi")));
  }
  return out;
}

/** Chi tiết một việc dọn để mở checklist. */
export async function cleaningTask(db: DB, user: SessionUser, taskId: string, now = new Date()) {
  requirePermission(user, "workTask");
  const t = await loadTaskForWork(db, user, taskId);
  if (t.type !== "CLEANING") throw notFound("Không tìm thấy việc dọn phòng");
  const board = (await boardFor(db, [t.propertyId], dayVN(t.dueAt) < D.todayVN(now) ? D.todayVN(now) : dayVN(t.dueAt), now)).get(t.propertyId) ?? [];
  const room = board.find((r) => r.taskId === t.id);
  const [p] = await db.select({ name: properties.name }).from(properties).where(eq(properties.id, t.propertyId)).limit(1);
  const cl = (await db.select().from(checklistResults).where(eq(checklistResults.taskId, t.id)).limit(1))[0]?.results as ChecklistItem[] | undefined;
  const checklist = cl ?? [];
  return {
    task: t, propertyName: p?.name ?? "", room, checklist,
    blocker: t.status === "DONE" ? null : completionBlocker(t.type, t.photoUrls, checklist),
  };
}

async function writeChecklist(db: DB, taskId: string, list: ChecklistItem[]) {
  await db.insert(checklistResults).values({ taskId, results: list }).onConflictDoUpdate({ target: checklistResults.taskId, set: { results: list } });
}

/** Tick / bỏ tick một mục checklist. */
export async function toggleChecklistItem(db: DB, user: SessionUser, taskId: string, index: number, done: boolean) {
  const t = await loadTaskForWork(db, user, taskId);
  if (t.status === "DONE" || t.status === "CANCELLED") throw badRequest("Việc đã đóng");
  const [cl] = await db.select().from(checklistResults).where(eq(checklistResults.taskId, taskId)).limit(1);
  const list = [...((cl?.results ?? []) as ChecklistItem[])];
  if (!list[index]) throw badRequest("Không có mục này");
  list[index] = { ...list[index], done };
  await writeChecklist(db, taskId, list);
  if (t.status === "TODO") await db.update(tasks).set({ status: "IN_PROGRESS" }).where(eq(tasks.id, taskId));
}

/** Gắn ảnh cho một mục checklist (chụp lại thì thay ảnh cũ). Ảnh cũng vào danh sách ảnh nghiệm thu của việc. */
export async function setChecklistPhoto(db: DB, user: SessionUser, taskId: string, index: number, url: string) {
  const t = await loadTaskForWork(db, user, taskId);
  if (t.status === "DONE" || t.status === "CANCELLED") throw badRequest("Việc đã đóng");
  const [cl] = await db.select().from(checklistResults).where(eq(checklistResults.taskId, taskId)).limit(1);
  const list = [...((cl?.results ?? []) as ChecklistItem[])];
  if (!list[index]) throw badRequest("Không có mục này");
  // Có ảnh tức là đã làm mục đó: tick luôn cho nhân viên đỡ một thao tác
  list[index] = { ...list[index], photo: url, done: true };
  await writeChecklist(db, taskId, list);
  await db.update(tasks).set({ photoUrls: [...t.photoUrls, url], status: t.status === "TODO" ? "IN_PROGRESS" : t.status }).where(eq(tasks.id, taskId));
}

/** Hoàn thành phòng: đủ tick và đủ ảnh bắt buộc (kiểm tra trong setTaskStatus). */
export async function completeCleaning(db: DB, user: SessionUser, taskId: string) {
  await setTaskStatus(db, user, taskId, "DONE");
}

// ---------- Lịch tuần ----------
export interface CalendarEvent {
  date: string;
  time: string;
  roomName: string;
  kind: "OUT" | "IN";
  guestName: string | null;
  state: CleanState | "upcoming" | "none";
  taskId: string | null;
}

/** Lịch trả phòng (cần dọn) và khách đến trong 7 ngày bắt đầu từ `from`, kèm trạng thái việc dọn. */
export async function cleaningCalendar(db: DB, user: SessionUser, propertyId: string, from: string, now = new Date()): Promise<CalendarEvent[]> {
  requirePermission(user, "workTask");
  await assertWorkable(db, user, propertyId, D.todayVN(now));
  const to = D.addDays(from, 6);
  const [bs, rs, ts, checkInHour, outHour] = await Promise.all([
    db.select().from(bookings).where(and(eq(bookings.propertyId, propertyId), eq(bookings.status, "CONFIRMED"),
      or(and(gte(bookings.checkIn, from), lte(bookings.checkIn, to)), and(gte(bookings.checkOut, from), lte(bookings.checkOut, to))))),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(eq(rooms.propertyId, propertyId)),
    db.select().from(tasks).where(and(eq(tasks.propertyId, propertyId), eq(tasks.type, "CLEANING"), ne(tasks.status, "CANCELLED"),
      gte(tasks.dueAt, at(from, "00:00")), lt(tasks.dueAt, at(D.addDays(to, 1), "00:00")))),
    getSetting(db, "checkInHour"),
    getSetting(db, "checkOutHour"),
  ]);
  const name = new Map(rs.map((r) => [r.id, r.name]));
  const today = D.todayVN(now);
  const board = new Map(((await boardFor(db, [propertyId], today, now)).get(propertyId) ?? []).map((r) => [r.taskId, r.state]));
  const taskState = (taskId: string | null, date: string): CalendarEvent["state"] => {
    if (!taskId) return date > today ? "upcoming" : "none";
    const t = ts.find((x) => x.id === taskId)!;
    if (t.status === "DONE") return "done";
    return board.get(taskId) ?? (date > today ? "upcoming" : "todo");
  };
  const ev: CalendarEvent[] = [];
  for (const b of bs) {
    const room = name.get(b.roomId) ?? "Phòng";
    if (b.checkOut >= from && b.checkOut <= to) {
      const t = ts.find((x) => x.bookingId === b.id) ?? null;
      ev.push({ date: b.checkOut, time: outHour || "12:00", roomName: room, kind: "OUT", guestName: b.guestName, state: taskState(t?.id ?? null, b.checkOut), taskId: t?.id ?? null });
    }
    if (b.checkIn >= from && b.checkIn <= to) {
      // Khách đến: trạng thái là của việc dọn phòng đó còn mở (nếu có)
      const open = ts.find((x) => x.roomId === b.roomId && dayVN(x.dueAt) <= b.checkIn && x.status !== "DONE") ?? null;
      ev.push({ date: b.checkIn, time: checkInHour || "14:00", roomName: room, kind: "IN", guestName: b.guestName, state: open ? taskState(open.id, b.checkIn) : b.checkIn > today ? "upcoming" : "done", taskId: open?.id ?? null });
    }
  }
  return ev.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.roomName.localeCompare(b.roomName, "vi"));
}

// ---------- Sự cố cơ sở vật chất ----------
export const ISSUE_CATEGORY: Record<string, string> = { KEY: "Chìa khoá / thẻ từ", SUPPLY: "Thiếu đồ dùng", BROKEN: "Thiết bị hỏng", OTHER: "Khác" };

export async function reportIssue(db: DB, user: SessionUser, i: { propertyId: string; roomId?: string | null; category: string; description: string; photoUrl?: string | null }) {
  requirePermission(user, "workTask");
  await assertWorkable(db, user, i.propertyId);
  if (!ISSUE_CATEGORY[i.category]) throw badRequest("Chọn loại sự cố");
  const description = i.description.trim();
  if (!description) throw badRequest("Mô tả ngắn sự cố");
  if (i.roomId) {
    const [r] = await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.id, i.roomId), eq(rooms.propertyId, i.propertyId))).limit(1);
    if (!r) throw badRequest("Phòng không thuộc cơ sở này");
  }
  const [row] = await db.insert(facilityIssues).values({
    propertyId: i.propertyId, roomId: i.roomId || null, category: i.category, description, photoUrl: i.photoUrl ?? null, reportedById: user.id,
  }).returning();
  const [p] = await db.select({ name: properties.name }).from(properties).where(eq(properties.id, i.propertyId)).limit(1);
  await notifyLark(db, `LOCI – sự cố mới tại ${p?.name ?? "cơ sở"}: ${ISSUE_CATEGORY[i.category]}. ${description} (${user.name} báo)`).catch(() => {});
  return row;
}

export interface IssueRow {
  id: string;
  propertyId: string;
  propertyName: string;
  roomName: string | null;
  category: string;
  description: string;
  photoUrl: string | null;
  reportedBy: string;
  reportedAt: Date;
  assigneeId: string | null;
  assignee: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  /** Số ngày đã mở (tính tới lúc đóng nếu đã đóng). */
  ageDays: number;
}

/** Sự cố của các cơ sở người dùng xem được. Buồng phòng: cơ sở mình làm hôm nay. */
export async function listIssues(db: DB, user: SessionUser, opts: { propertyIds?: string[]; openOnly?: boolean; since?: Date } = {}, now = new Date()): Promise<IssueRow[]> {
  requirePermission(user, "workTask");
  const allowed = await workablePropertyIds(db, user, D.todayVN(now));
  const pids = opts.propertyIds ? opts.propertyIds.filter((p) => allowed.includes(p)) : allowed;
  if (!pids.length) return [];
  const conds = [inArray(facilityIssues.propertyId, pids)];
  if (opts.openOnly) conds.push(isNull(facilityIssues.resolvedAt));
  if (opts.since) conds.push(or(isNull(facilityIssues.resolvedAt), gte(facilityIssues.reportedAt, opts.since))!);
  const rows = await db.select().from(facilityIssues).where(and(...conds)).orderBy(asc(facilityIssues.reportedAt));
  if (!rows.length) return [];
  const uids = [...new Set(rows.flatMap((r) => [r.reportedById, r.assigneeId]).filter(Boolean) as string[])];
  const [us, ps, rs] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uids)),
    db.select({ id: properties.id, name: properties.name }).from(properties).where(inArray(properties.id, pids)),
    db.select({ id: rooms.id, name: rooms.name }).from(rooms).where(inArray(rooms.propertyId, pids)),
  ]);
  const n = (list: { id: string; name: string }[], id: string | null) => (id ? list.find((x) => x.id === id)?.name ?? null : null);
  return rows.map((r) => ({
    id: r.id, propertyId: r.propertyId, propertyName: n(ps, r.propertyId) ?? "", roomName: n(rs, r.roomId), category: r.category,
    description: r.description, photoUrl: r.photoUrl, reportedBy: n(us, r.reportedById) ?? "", reportedAt: r.reportedAt,
    assigneeId: r.assigneeId, assignee: n(us, r.assigneeId), resolvedAt: r.resolvedAt, resolutionNote: r.resolutionNote,
    ageDays: Math.floor(((r.resolvedAt ?? now).getTime() - r.reportedAt.getTime()) / 86400_000),
  }));
}

async function loadIssue(db: DB, user: SessionUser, id: string) {
  const [r] = await db.select().from(facilityIssues).where(eq(facilityIssues.id, id)).limit(1);
  if (!r) throw notFound("Không tìm thấy sự cố");
  await assertPropertyAccess(db, user, r.propertyId);
  return r;
}

/** Quản lý giao người xử lý sự cố. */
export async function assignIssue(db: DB, user: SessionUser, id: string, assigneeId: string | null) {
  requirePermission(user, "assignTask");
  await loadIssue(db, user, id);
  await db.update(facilityIssues).set({ assigneeId }).where(eq(facilityIssues.id, id));
}

/** Đóng sự cố: quản lý, hoặc người được giao xử lý. */
export async function resolveIssue(db: DB, user: SessionUser, id: string, note: string) {
  const [r] = await db.select().from(facilityIssues).where(eq(facilityIssues.id, id)).limit(1);
  if (!r) throw notFound("Không tìm thấy sự cố");
  if (can(user, "assignTask")) await assertPropertyAccess(db, user, r.propertyId);
  else if (r.assigneeId !== user.id) throw forbidden("Chỉ quản lý hoặc người được giao mới đóng được sự cố");
  if (r.resolvedAt) throw badRequest("Sự cố đã đóng");
  await db.update(facilityIssues).set({ resolvedAt: new Date(), resolvedById: user.id, resolutionNote: note.trim() || null }).where(eq(facilityIssues.id, id));
}

// ---------- Daily report ----------
export type Tone = "bad" | "warn" | "info";
export interface ReportAlert { tone: Tone; kind: "urgent" | "missing" | "unfinished" | "support" | "issue"; title: string; detail: string; propertyId: string; href?: string }

export interface PropertyDay {
  propertyId: string;
  name: string;
  main: string[];
  support: string[];
  total: number;
  done: number;
  missingPhotos: number;
  urgent: number;
  status: { tone: Tone | "ok" | "doing"; label: string };
}

export interface StaffShift { userId: string; name: string; propertyId: string; support: boolean; checkInAt: Date; checkOutAt: Date | null }

/** Quyền xem Daily report dọn phòng: quản lý và admin. */
export const canViewCleaningReport = (user: SessionUser) => can(user, "assignTask");

/** Daily report một ngày: tiến độ từng cơ sở, cảnh báo, ảnh kiểm tra, sự cố đang mở. */
export async function cleaningDailyReport(db: DB, user: SessionUser, date = D.todayVN(), opts: { propertyId?: string } = {}, now = new Date()) {
  if (!canViewCleaningReport(user)) throw forbidden();
  const allowed = await allowedPropertyIds(db, user);
  const pids = opts.propertyId ? allowed.filter((p) => p === opts.propertyId) : allowed;
  const props = pids.length ? await db.select({ id: properties.id, name: properties.name }).from(properties)
    .where(and(inArray(properties.id, pids), eq(properties.active, true))).orderBy(asc(properties.name)) : [];
  const ids = props.map((p) => p.id);
  const [board, shiftsRaw, issues] = await Promise.all([
    boardFor(db, ids, date, now),
    ids.length ? db.select().from(attendance).where(and(inArray(attendance.propertyId, ids), eq(attendance.date, date))) : Promise.resolve([]),
    listIssues(db, user, { propertyIds: ids, openOnly: true }, now),
  ]);
  const staffIds = [...new Set([...shiftsRaw.map((s) => s.userId), ...[...board.values()].flat().flatMap((r) => [r.assigneeId, r.completedById]).filter(Boolean) as string[]])];
  const names = new Map((staffIds.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, staffIds)) : []).map((u) => [u.id, u.name]));
  const nm = (id: string | null) => (id ? names.get(id) ?? "—" : "Chưa giao");
  const shifts: StaffShift[] = shiftsRaw.map((s) => ({ userId: s.userId, name: nm(s.userId), propertyId: s.propertyId, support: s.support, checkInAt: s.checkInAt, checkOutAt: s.checkOutAt }));
  const isToday = date === D.todayVN(now);

  const alertsOut: ReportAlert[] = [];
  const rows: PropertyDay[] = props.map((p) => {
    const list = board.get(p.id) ?? [];
    const sh = shifts.filter((s) => s.propertyId === p.id);
    const done = list.filter((r) => r.state === "done");
    const open = list.filter((r) => r.state !== "done");
    const urgent = list.filter((r) => r.state === "urgent");
    const missing = done.filter((r) => r.missingPhotos);
    for (const r of urgent) {
      const m = r.minutesToCheckIn ?? 0;
      alertsOut.push({
        tone: "bad", kind: "urgent", propertyId: p.id, href: `/don-dep/${r.taskId}`,
        title: `${r.roomName} · ${p.name}: khách đến ${r.nextCheckInAt ? hmVN(r.nextCheckInAt) : ""}, phòng chưa dọn xong`,
        detail: `${m >= 0 ? `Còn ${m} phút` : `Đã quá giờ khách đến ${-m} phút`}. Phụ trách: ${nm(r.assigneeId)}. Đã làm ${r.ticks}/${r.total} việc, ${r.photos}/${r.photoNeed} ảnh.`,
      });
    }
    for (const r of missing) {
      alertsOut.push({
        tone: "bad", kind: "missing", propertyId: p.id, href: `/don-dep/${r.taskId}`,
        title: `${nm(r.completedById)} báo xong ${r.roomName} · ${p.name} nhưng thiếu ảnh`,
        detail: `Có ${r.photos}/${r.photoNeed || 1} ảnh bắt buộc${r.completedAt ? `, bấm xong lúc ${hmVN(r.completedAt)}` : ""}.`,
      });
    }
    // Hết ca mà còn phòng chưa xong: người đã ra ca và không còn ca nào khác đang mở ở cơ sở
    const stillOn = sh.some((s) => !s.checkOutAt);
    const ended = sh.filter((s) => s.checkOutAt);
    if (open.length && ended.length && !stillOn) {
      const who = [...new Set(ended.map((s) => s.name))].join(", ");
      alertsOut.push({
        tone: "warn", kind: "unfinished", propertyId: p.id,
        title: `${who} đã ra ca, ${p.name} còn ${open.length} phòng chưa xong`,
        detail: `${open.map((r) => r.roomName).join(", ")}. Ra ca lúc ${hmVN(ended.sort((a, b) => b.checkOutAt!.getTime() - a.checkOutAt!.getTime())[0].checkOutAt!)}.`,
      });
    } else if (isToday && open.length && !sh.length) {
      alertsOut.push({ tone: "warn", kind: "unfinished", propertyId: p.id, title: `${p.name}: còn ${open.length} phòng cần dọn nhưng chưa ai vào ca`, detail: open.map((r) => r.roomName).join(", ") });
    } else if (!isToday && open.length) {
      alertsOut.push({ tone: "warn", kind: "unfinished", propertyId: p.id, title: `${p.name}: ${open.length} phòng không hoàn thành trong ngày`, detail: open.map((r) => `${r.roomName} (${nm(r.assigneeId)})`).join(", ") });
    }
    for (const s of sh.filter((x) => x.support)) {
      alertsOut.push({ tone: "info", kind: "support", propertyId: p.id, title: `${s.name} làm ca hỗ trợ tại ${p.name}`, detail: `Vào ca ${hmVN(s.checkInAt)}${s.checkOutAt ? `, ra ca ${hmVN(s.checkOutAt)}` : ""}.` });
    }
    const status: PropertyDay["status"] = urgent.length ? { tone: "bad", label: "Phòng sắp có khách" }
      : open.length && ended.length && !stillOn ? { tone: "bad", label: "Hết ca, chưa xong" }
      : missing.length ? { tone: "warn", label: "Thiếu ảnh" }
      : !list.length ? { tone: "info", label: "Không có phòng cần dọn" }
      : !open.length ? { tone: "ok", label: "Hoàn thành" }
      : { tone: "doing", label: "Đang dọn" };
    return {
      propertyId: p.id, name: p.name,
      main: [...new Set(sh.filter((s) => !s.support).map((s) => s.name))], support: [...new Set(sh.filter((s) => s.support).map((s) => s.name))],
      total: list.length, done: done.length, missingPhotos: missing.length, urgent: urgent.length, status,
    };
  });
  for (const i of issues.filter((x) => x.ageDays >= 1)) {
    alertsOut.push({
      tone: i.ageDays >= 3 ? "bad" : "warn", kind: "issue", propertyId: i.propertyId,
      title: `Sự cố mở ${i.ageDays} ngày: ${ISSUE_CATEGORY[i.category] ?? i.category}${i.roomName ? ` ${i.roomName}` : ""} · ${i.propertyName}`,
      detail: `${i.description}. ${i.assignee ? `Đang giao ${i.assignee}.` : "Chưa giao ai xử lý."}`,
    });
  }
  const rank: Record<Tone, number> = { bad: 0, warn: 1, info: 2 };
  alertsOut.sort((a, b) => rank[a.tone] - rank[b.tone]);

  const photoCards = props.flatMap((p) => (board.get(p.id) ?? []).filter((r) => r.state === "done" || r.photos > 0).map((r) => ({
    taskId: r.taskId, roomName: r.roomName, propertyName: p.name, by: nm(r.completedById ?? r.assigneeId),
    completedAt: r.completedAt, done: r.state === "done", missing: r.missingPhotos,
    photos: r.checklist.filter((c) => c.needPhoto).map((c) => ({ item: c.item, url: c.photo ?? null })),
  })));

  const all = [...board.values()].flat();
  return {
    date, rows, alerts: alertsOut, photoCards, issues, shifts,
    totals: {
      total: all.length,
      done: all.filter((r) => r.state === "done").length,
      doneWithPhotos: all.filter((r) => r.state === "done" && !r.missingPhotos).length,
      missingPhotos: all.filter((r) => r.missingPhotos).length,
      open: all.filter((r) => r.state !== "done").length,
      urgent: all.filter((r) => r.state === "urgent").length,
      issuesOpen: issues.length,
      issuesStale: issues.filter((i) => i.ageDays >= 1).length,
      notFinished: alertsOut.filter((a) => a.kind === "unfinished").length,
    },
  };
}

/** Thứ Hai đầu tuần của một ngày. */
export function weekStart(date: string) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = CN
  return D.addDays(date, dow === 0 ? -6 : 1 - dow);
}

/** Báo cáo tuần (thứ Hai – Chủ nhật): ô từng cơ sở × ngày, và tổng hợp theo nhân viên. */
export async function cleaningWeeklyReport(db: DB, user: SessionUser, anyDay = D.todayVN(), now = new Date()) {
  if (!canViewCleaningReport(user)) throw forbidden();
  const from = weekStart(anyDay);
  const days = D.eachDay(from, D.addDays(from, 6));
  const today = D.todayVN(now);
  const allowed = await allowedPropertyIds(db, user);
  const props = allowed.length ? await db.select({ id: properties.id, name: properties.name }).from(properties)
    .where(and(inArray(properties.id, allowed), eq(properties.active, true))).orderBy(asc(properties.name)) : [];
  const ids = props.map((p) => p.id);
  if (!ids.length) return { from, days, grid: [], staff: [], totals: { total: 0, done: 0, onTime: 0, missingPhotos: 0, supportShifts: 0, issuesNew: 0, issuesClosed: 0 } };
  const [ts, shifts, issues, checkInHour] = await Promise.all([
    db.select().from(tasks).where(and(inArray(tasks.propertyId, ids), eq(tasks.type, "CLEANING"), ne(tasks.status, "CANCELLED"),
      gte(tasks.dueAt, at(from, "00:00")), lt(tasks.dueAt, at(D.addDays(from, 7), "00:00")))),
    db.select().from(attendance).where(and(inArray(attendance.propertyId, ids), gte(attendance.date, from), lte(attendance.date, D.addDays(from, 6)))),
    db.select().from(facilityIssues).where(and(inArray(facilityIssues.propertyId, ids), or(
      and(gte(facilityIssues.reportedAt, at(from, "00:00")), lt(facilityIssues.reportedAt, at(D.addDays(from, 7), "00:00"))),
      and(gte(facilityIssues.resolvedAt, at(from, "00:00")), lt(facilityIssues.resolvedAt, at(D.addDays(from, 7), "00:00"))),
    ))),
    getSetting(db, "checkInHour"),
  ]);
  const cls = ts.length ? await db.select().from(checklistResults).where(inArray(checklistResults.taskId, ts.map((t) => t.id))) : [];
  const ins = await db.select({ roomId: bookings.roomId, checkIn: bookings.checkIn }).from(bookings)
    .where(and(inArray(bookings.propertyId, ids), eq(bookings.status, "CONFIRMED"), gte(bookings.checkIn, from), lte(bookings.checkIn, D.addDays(from, 6))));
  const incoming = new Set(ins.map((b) => `${b.roomId}|${b.checkIn}`));
  const info = ts.map((t) => {
    const cl = (cls.find((c) => c.taskId === t.id)?.results ?? []) as ChecklistItem[];
    const st = checklistStats(cl, t.photoUrls);
    const date = dayVN(t.dueAt);
    const guestAt = t.roomId && incoming.has(`${t.roomId}|${date}`) ? at(date, checkInHour || "14:00") : null;
    const done = t.status === "DONE";
    const late = guestAt ? (done ? t.completedAt! > guestAt : now > guestAt) : !done && date < today;
    return { t, date, done, late, missing: done && (st.photoNeed ? st.photos < st.photoNeed : st.photos === 0) };
  });
  const grid = props.map((p) => ({
    propertyId: p.id, name: p.name,
    cells: days.map((d) => {
      const list = info.filter((x) => x.t.propertyId === p.id && x.date === d);
      const done = list.filter((x) => x.done).length;
      const flag: Tone | "ok" | "none" | "future" = !list.length ? "none" : list.some((x) => x.late) ? "bad" : list.some((x) => x.missing) ? "warn" : d > today ? "future" : done === list.length ? "ok" : d < today ? "bad" : "info";
      return { date: d, total: list.length, done, flag };
    }),
  }));
  const uids = [...new Set([...shifts.map((s) => s.userId), ...info.flatMap((x) => [x.t.completedById, x.t.assigneeId]).filter(Boolean) as string[]])];
  const us = uids.length ? await db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.id, uids)) : [];
  const pname = new Map(props.map((p) => [p.id, p.name]));
  const staff = us.filter((u) => u.role === "HOUSEKEEPER" || shifts.some((s) => s.userId === u.id)).map((u) => {
    const mine = shifts.filter((s) => s.userId === u.id);
    const mainP = [...new Set(mine.filter((s) => !s.support).map((s) => pname.get(s.propertyId) ?? ""))];
    const supportCount = new Map<string, number>();
    for (const s of mine.filter((x) => x.support)) supportCount.set(s.propertyId, (supportCount.get(s.propertyId) ?? 0) + 1);
    const doneBy = info.filter((x) => x.done && x.t.completedById === u.id);
    const withPhotos = doneBy.filter((x) => !x.missing).length;
    const warnings = info.filter((x) => (x.t.completedById === u.id || (!x.done && x.t.assigneeId === u.id)) && (x.late || x.missing)).length;
    return {
      userId: u.id, name: u.name, main: mainP.join(", ") || "—",
      support: [...supportCount].map(([p, n]) => `${pname.get(p)} ×${n}`).join(", ") || "—",
      shifts: mine.length, rooms: doneBy.length, photoPct: doneBy.length ? Math.round((withPhotos / doneBy.length) * 100) : null, warnings,
    };
  }).sort((a, b) => b.warnings - a.warnings || a.name.localeCompare(b.name, "vi"));
  const doneAll = info.filter((x) => x.done);
  return {
    from, days, grid, staff,
    totals: {
      total: info.length, done: doneAll.length, onTime: doneAll.filter((x) => !x.late).length, missingPhotos: info.filter((x) => x.missing).length,
      supportShifts: shifts.filter((s) => s.support).length,
      issuesNew: issues.filter((i) => i.reportedAt >= at(from, "00:00") && i.reportedAt < at(D.addDays(from, 7), "00:00")).length,
      issuesClosed: issues.filter((i) => i.resolvedAt).length,
    },
  };
}

// ---------- Cảnh báo tự động ----------
const CLEANING_ALERT_TYPES = ["CLEANING_URGENT", "ISSUE_STALE"];

/**
 * Cảnh báo dọn phòng, chạy định kỳ (job hằng ngày, hẹn giờ trong app, hoặc /api/cron/cleaning):
 * phòng sắp có khách mà chưa dọn xong, và sự cố cơ sở vật chất mở quá 24 giờ. Cảnh báo mới gửi Lark.
 */
export async function computeCleaningAlerts(db: DB, now = new Date()) {
  const today = D.todayVN(now);
  const active = new Set<string>();
  const fresh: string[] = [];
  const open = async (type: string, key: string, message: string, propertyId: string) => {
    active.add(key);
    const [ex] = await db.select().from(alerts).where(eq(alerts.key, key)).limit(1);
    if (!ex) {
      await db.insert(alerts).values({ type, key, message, propertyId, month: D.monthOf(today) });
      fresh.push(message);
    } else if (ex.resolvedAt) {
      await db.update(alerts).set({ resolvedAt: null, message }).where(eq(alerts.id, ex.id));
      fresh.push(message);
    }
  };
  const props = await db.select({ id: properties.id, name: properties.name }).from(properties).where(eq(properties.active, true));
  const board = await boardFor(db, props.map((p) => p.id), today, now);
  for (const p of props) {
    for (const r of (board.get(p.id) ?? []).filter((x) => x.state === "urgent")) {
      await open("CLEANING_URGENT", `CLEANING_URGENT:${r.taskId}:${today}`, `${p.name} ${r.roomName}: khách đến ${r.nextCheckInAt ? hmVN(r.nextCheckInAt) : ""}, phòng chưa dọn xong – dọn ngay`, p.id);
    }
  }
  const stale = await db.select().from(facilityIssues).where(and(isNull(facilityIssues.resolvedAt), lt(facilityIssues.reportedAt, new Date(now.getTime() - 86400_000))));
  for (const i of stale) {
    const p = props.find((x) => x.id === i.propertyId);
    const days = Math.floor((now.getTime() - i.reportedAt.getTime()) / 86400_000);
    // Khóa theo ngày: sự cố còn mở thì mỗi ngày nhắc lại một lần
    await open("ISSUE_STALE", `ISSUE_STALE:${i.id}:${today}`, `${p?.name ?? "Cơ sở"}: sự cố "${ISSUE_CATEGORY[i.category] ?? i.category}" mở ${days} ngày chưa xử lý – ${i.description}`, i.propertyId);
  }
  await db.update(alerts).set({ resolvedAt: new Date() }).where(and(
    inArray(alerts.type, CLEANING_ALERT_TYPES), isNull(alerts.resolvedAt), active.size ? notInArray(alerts.key, [...active]) : undefined,
  ));
  if (fresh.length) await notifyLark(db, `LOCI – cảnh báo dọn phòng:\n• ${fresh.join("\n• ")}`).catch(() => {});
  return { opened: fresh.length, active: active.size };
}

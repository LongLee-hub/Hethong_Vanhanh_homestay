// @ts-nocheck
// Lõi app: trạng thái, lưu trữ dùng chung, phân quyền, số liệu dẫn xuất.
import * as D from "../lib/domain";
import { makeSampleData } from "./seed";

export { D };

export const COLLECTIONS = [
  "investors", "properties", "bookings", "expenses", "categories", "periods",
  "settlements", "adjustments", "staff", "tasks", "attendance", "config",
];

export const ROLE_LABEL = {
  ADMIN: "Admin LOCI", INVESTOR: "Nhà đầu tư", MANAGER: "Quản lý cơ sở", ACCOUNTANT: "Kế toán", HOUSEKEEPER: "Buồng phòng",
};

export const TASK_TYPE = {
  CLEANING: "Dọn phòng", CHECKIN: "Check-in", CHECKOUT: "Check-out", MAINTENANCE: "Bảo trì", PURCHASE: "Mua sắm",
  BAD_REVIEW: "Xử lý đánh giá", INVENTORY: "Kiểm kho", RECURRING: "Định kỳ",
};
export const TASK_STATUS = { TODO: "Cần làm", IN_PROGRESS: "Đang làm", DONE: "Hoàn thành", CANCELLED: "Đã hủy" };
export const PRIORITY = { LOW: "Thấp", MEDIUM: "Vừa", HIGH: "Cao", URGENT: "Khẩn" };

export const S = {
  data: Object.fromEntries(COLLECTIONS.map((c) => [c, []])),
  loaded: new Set(),
  mode: "loading", // loading | live | demo
  db: null, assets: null, downloads: null, user: null,
  version: 0,
  today: D.todayVN(),
  month: D.todayVN().slice(0, 7),
  route: "dashboard",
  prop: "all",
  meId: null,
  ui: {},
};

// ---------- Tiện ích ----------
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const vnd = (n) => D.formatVND(n || 0);
export const dvn = (d) => (d ? D.formatDateVN(String(d).slice(0, 10)) : "");
export const mvn = (m) => D.formatMonthVN(m);
export const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const byId = (coll, id) => S.data[coll].find((x) => x.id === id);
export const nowVN = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16);
export const parseMoney = (s) => {
  const n = Number(String(s ?? "").replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
};
export const signCls = (n) => (n < 0 ? "neg" : n > 0 ? "pos" : "");

const LS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let toastT;
export function toast(msg) {
  const el = document.getElementById("toast");
  el.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
  clearTimeout(toastT);
  toastT = setTimeout(() => (el.innerHTML = ""), 3200);
}

// ---------- Lưu trữ ----------
let renderFn = () => {};
let rafPending = false;
export function onChange(fn) { renderFn = fn; }
export function scheduleRender() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderFn(); });
}
function bump() { S.version++; memo.clear(); scheduleRender(); }

const writeQueues = new Map();
function queued(key, fn) {
  const prev = writeQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeQueues.set(key, next);
  return next;
}

function strip(doc) {
  const { id, ...rest } = doc;
  return JSON.parse(JSON.stringify(rest));
}

export async function save(coll, doc) {
  const id = doc.id;
  const list = S.data[coll];
  const i = list.findIndex((x) => x.id === id);
  if (S.mode !== "live") {
    if (i >= 0) list[i] = doc; else list.push(doc);
    bump();
    return;
  }
  // Hiển thị ngay, máy chủ xác nhận sau
  const copy = [...list];
  if (i >= 0) copy[i] = doc; else copy.push(doc);
  S.data[coll] = copy;
  bump();
  try {
    await queued(`${coll}/${id}`, () => S.db.doc(`${coll}/${id}`).set(strip(doc)));
  } catch (e) {
    toast(writeError(e));
    throw e;
  }
}

export async function remove(coll, id) {
  S.data[coll] = S.data[coll].filter((x) => x.id !== id);
  bump();
  if (S.mode !== "live") return;
  try {
    await queued(`${coll}/${id}`, () => S.db.doc(`${coll}/${id}`).delete());
  } catch (e) {
    toast(writeError(e));
  }
}

function writeError(e) {
  if (e?.code === "invalid_argument") return "Tài khoản này chỉ có quyền xem, không lưu được thay đổi.";
  if (e?.code === "quota_exceeded") return "Kho dữ liệu đã đầy. Xóa bớt dữ liệu cũ rồi thử lại.";
  if (e?.code === "resource_exhausted") return "Thao tác quá nhanh. Đợi vài giây rồi thử lại.";
  return "Không lưu được. Kiểm tra kết nối rồi thử lại.";
}

export async function boot() {
  S.meId = LS.get("loci.me");
  S.route = LS.get("loci.route") || "dashboard";
  const hash = location.hash.replace("#", "");
  if (hash) S.route = hash;
  const c = window.claude;
  const [db, assets, downloads, user] = await Promise.all([
    c?.use?.("db") ?? null, c?.use?.("assets") ?? null, c?.use?.("downloads") ?? null, c?.use?.("user") ?? null,
  ]);
  S.assets = assets; S.downloads = downloads; S.user = user;
  if (!db) {
    S.mode = "demo";
    const sample = makeSampleData(S.today);
    for (const c of COLLECTIONS) S.data[c] = sample[c] ?? [];
    bump();
    return;
  }
  S.db = db;
  S.mode = "live";
  for (const coll of COLLECTIONS) {
    db.collection(coll).limit(1000).onSnapshot(
      (snap) => {
        S.data[coll] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        S.loaded.add(coll);
        bump();
      },
      () => { S.loaded.add(coll); bump(); },
    );
  }
  setTimeout(() => { COLLECTIONS.forEach((c) => S.loaded.add(c)); bump(); }, 8000);
  bump();
}

export function isLoaded() { return S.mode === "demo" || COLLECTIONS.every((c) => S.loaded.has(c)); }
export function isEmpty() { return S.data.properties.length === 0 && S.data.staff.length === 0; }

export async function loadSample() {
  const sample = makeSampleData(S.today);
  for (const coll of COLLECTIONS) for (const doc of sample[coll] || []) await save(coll, doc);
}

export async function clearSample() {
  for (const coll of COLLECTIONS) {
    if (coll === "config" || coll === "categories") continue;
    for (const doc of [...S.data[coll]]) if (doc.sample) await remove(coll, doc.id);
  }
}

// ---------- Người dùng hiện tại & phân quyền ----------
export function setMe(id) { S.meId = id; LS.set("loci.me", id); bump(); }
export function setRoute(r) { S.route = r; LS.set("loci.route", r); S.ui = {}; bump(); window.scrollTo?.(0, 0); }

export function me() {
  const staff = S.data.staff.filter((s) => s.active !== false);
  return staff.find((s) => s.id === S.meId) || staff.find((s) => s.role === "ADMIN") || staff[0] || { id: "u-admin", name: "Admin", role: "ADMIN", propertyIds: [] };
}
export const role = () => me().role;

const CAN = {
  ADMIN: ["finance", "fee", "bookings", "bookingAmounts", "createBooking", "expenses", "editExpense", "commonCost", "settle", "lock", "tasks", "assign", "attendance", "attendanceAll", "reports", "admin"],
  INVESTOR: ["finance", "fee", "bookings", "bookingAmounts", "expenses", "settle", "reports"],
  MANAGER: ["finance", "bookings", "bookingAmounts", "createBooking", "expenses", "tasks", "assign", "attendance", "attendanceAll", "reports"],
  ACCOUNTANT: ["finance", "fee", "bookings", "bookingAmounts", "createBooking", "expenses", "editExpense", "commonCost", "settle", "tasks", "attendance", "reports"],
  HOUSEKEEPER: ["bookings", "tasks", "attendance"],
};
export const can = (p) => (CAN[role()] || []).includes(p);

/** Tương đương allowedPropertyIds(user) trong đặc tả. */
export function allowedPropertyIds() {
  const u = me();
  const props = S.data.properties;
  if (u.role === "ADMIN") return props.map((p) => p.id);
  if (u.role === "INVESTOR") return props.filter((p) => p.investorId === u.investorId).map((p) => p.id);
  return props.filter((p) => (u.propertyIds || []).includes(p.id)).map((p) => p.id);
}
export function visiblePropertyIds() {
  const ids = allowedPropertyIds();
  return S.prop === "all" || !ids.includes(S.prop) ? ids : [S.prop];
}
export function visibleProperties() {
  const ids = visiblePropertyIds();
  return S.data.properties.filter((p) => ids.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name, "vi"));
}
export function visibleInvestors() {
  const pids = visiblePropertyIds();
  const invIds = new Set(S.data.properties.filter((p) => pids.includes(p.id)).map((p) => p.investorId));
  return S.data.investors.filter((i) => invIds.has(i.id));
}

// ---------- Dữ liệu dẫn xuất (ghi nhớ theo phiên bản) ----------
const memo = new Map();
function m(key, fn) {
  if (!memo.has(key)) memo.set(key, fn());
  return memo.get(key);
}

export const config = () => ({ managementFeePct: 20, commission: {}, checklist: [], ...(byId("config", "app") || {}) });
export const feePct = () => Number(config().managementFeePct ?? 20);

export const allRooms = () =>
  m("rooms", () => S.data.properties.flatMap((p) => (p.rooms || []).map((r) => ({ ...r, propertyId: p.id }))));
export const roomById = (id) => allRooms().find((r) => r.id === id);
export const propName = (id) => byId("properties", id)?.name ?? "—";
export const invName = (id) => byId("investors", id)?.name ?? "—";
export const staffName = (id) => byId("staff", id)?.name ?? "—";

export const allBookings = () => m("bookings", () => S.data.bookings.flatMap((b) => b.items || []));
export const bookingById = (id) => allBookings().find((b) => b.id === id);
export const nights = () => m("nights", () => allBookings().flatMap((b) => { try { return D.splitNights(b); } catch { return []; } }));

export function isCommonFinalized(month) { return !!byId("periods", month)?.commonCostsFinalized; }

export function settlementDoc(invId, month) { return byId("settlements", `${invId}__${month}`); }
export function isLocked(invId, month) { return settlementDoc(invId, month)?.status === "LOCKED"; }
export function isPropLocked(propertyId, month) {
  const p = byId("properties", propertyId);
  return p ? isLocked(p.investorId, month) : false;
}
export function isAnyLocked(month) { return S.data.investors.some((i) => isLocked(i.id, month)); }

/** Quyết toán của NĐT cho tháng; tháng đã khóa đọc từ bản lưu. */
export function settlement(invId, month) {
  return m(`set:${invId}:${month}`, () => {
    const doc = settlementDoc(invId, month);
    if (doc?.status === "LOCKED") return { ...doc, locked: true };
    const pids = S.data.properties.filter((p) => p.investorId === invId).map((p) => p.id);
    const s = D.settleInvestorMonth({
      month, propertyIds: pids, rooms: allRooms(), nights: nights(), expenses: S.data.expenses,
      adjustments: S.data.adjustments, commonFinalized: isCommonFinalized(month), feePct: feePct(),
    });
    return { ...s, investorId: invId, locked: false, unlockLog: doc?.unlockLog || [] };
  });
}

export function currentMonth() { return S.today.slice(0, 7); }

/** Số tháng hiện tại & dự kiến cho một NĐT, giới hạn trong các cơ sở được xem. */
export function investorMonthView(invId, month, pids) {
  return m(`imv:${invId}:${month}:${pids.join(",")}`, () => {
    const props = S.data.properties.filter((p) => p.investorId === invId && pids.includes(p.id));
    const cur = currentMonth();
    const common = D.commonCostForMonth({ month, expenses: S.data.expenses, rooms: allRooms(), finalized: isCommonFinalized(month) });
    const lines = props.map((p) => {
      const rooms = allRooms().filter((r) => r.propertyId === p.id);
      const pn = nights().filter((n) => n.propertyId === p.id);
      const adj = S.data.adjustments.filter((a) => a.propertyId === p.id && a.appliedMonth === month).reduce((s, a) => s + a.amount, 0);
      const direct = S.data.expenses.filter((e) => e.propertyId === p.id && e.month === month).reduce((s, e) => s + e.amount, 0);
      const commonAlloc = common.perProperty[p.id] ?? 0;
      const k = D.computeKpis(pn, rooms, D.firstDay(month), D.lastDay(month));
      let fc;
      if (month < cur) {
        fc = { revenueForecast: k.revenue, costForecast: direct + commonAlloc, revenuePast: k.revenue };
      } else {
        fc = D.forecastProperty({
          month, today: S.today, rooms, nights: pn,
          fixedCostMonthly: p.fixedCostMonthly || 0, variableCostPerNight: p.variableCostPerNight || 0, commonCost: commonAlloc,
        });
      }
      return {
        property: p, k, adj, direct, commonAlloc, fc,
        revenueActual: (month < cur ? k.revenue : fc.revenuePast) + adj,
        revenueForecast: fc.revenueForecast + adj,
        costActual: direct + commonAlloc,
        costForecast: fc.costForecast,
      };
    });
    const sum = (f) => lines.reduce((s, l) => s + f(l), 0);
    const profitForecast = sum((l) => l.revenueForecast) - sum((l) => l.costForecast);
    const fee = D.managementFee(profitForecast, feePct());
    return {
      lines,
      revenueActual: sum((l) => l.revenueActual),
      revenueForecast: sum((l) => l.revenueForecast),
      costActual: sum((l) => l.costActual),
      costForecast: sum((l) => l.costForecast),
      profitForecast, fee, net: profitForecast - fee,
      provisional: common.provisional,
    };
  });
}

export function paybackFor(invId) {
  const props = S.data.properties.filter((p) => p.investorId === invId);
  const investmentTotal = props.reduce((s, p) => s + (p.investmentAmount || 0), 0);
  const startMonth = props.map((p) => p.investmentStartMonth).filter(Boolean).sort()[0];
  const lockedNets = S.data.settlements.filter((s) => s.investorId === invId && s.status === "LOCKED").map((s) => ({ month: s.month, investorNet: s.investorNet }));
  return { investmentTotal, ...D.payback({ investmentTotal, lockedNets, startMonth }) };
}

/** Cảnh báo tính trực tiếp (bản chạy thử không có job nền). */
export function alerts() {
  return m("alerts", () => {
    const out = [];
    const pids = allowedPropertyIds();
    const month = currentMonth();
    for (const p of S.data.properties.filter((p) => pids.includes(p.id))) {
      const rooms = allRooms().filter((r) => r.propertyId === p.id);
      const k = D.computeKpis(nights().filter((n) => n.propertyId === p.id), rooms, D.firstDay(month), D.lastDay(month));
      if (k.availableNights && k.occupancyPct < (p.occupancyKpiPct ?? 70))
        out.push({ type: "LOW_OCCUPANCY", level: "warn", text: `${p.name}: công suất tháng này ${k.occupancyPct}% (gồm đêm đã đặt), dưới mức ${p.occupancyKpiPct ?? 70}%` });
    }
    const now = nowVN();
    for (const t of S.data.tasks.filter((t) => pids.includes(t.propertyId) && ["TODO", "IN_PROGRESS"].includes(t.status) && t.dueAt < now)) {
      if (role() === "HOUSEKEEPER" && t.assigneeId !== me().id) continue;
      out.push({ type: "TASK_OVERDUE", level: "bad", text: `Quá hạn: ${t.title} (${propName(t.propertyId)}, hạn ${dvn(t.dueAt)} ${t.dueAt.slice(11, 16)})`, taskId: t.id });
    }
    if (can("settle")) {
      for (const a of S.data.adjustments.filter((a) => !a.acknowledged && pids.includes(a.propertyId)))
        out.push({ type: "LOCKED_MONTH_CHANGED", level: "warn", text: `Đơn thay đổi ảnh hưởng ${mvn(a.originalMonth)} đã khóa: ${vnd(a.amount)} ghi vào ${mvn(a.appliedMonth)} (${propName(a.propertyId)})`, adjId: a.id });
    }
    if (can("admin")) {
      const orphan = allBookings().filter((b) => !roomById(b.roomId));
      if (orphan.length) out.push({ type: "UNMAPPED_ROOM", level: "warn", text: `${orphan.length} đơn có phòng chưa được gắn với phòng trong hệ thống` });
    }
    return out;
  });
}

// ---------- Ghi đơn đặt phòng (gom theo cơ sở × tháng check-in) ----------
function bucketId(b) { return `${b.propertyId}__${b.checkIn.slice(0, 7)}`; }

export async function saveBooking(next, changedBy, reason = "") {
  const prev = bookingById(next.id);
  const entry = { at: nowVN(), by: changedBy, reason, before: prev ? pickLog(prev) : null, after: pickLog(next) };
  next = { ...next, log: [...(prev?.log || []), entry] };

  // Mục 5.6: thay đổi ảnh hưởng tháng đã khóa sinh khoản điều chỉnh
  if (prev) {
    const inv = byId("properties", next.propertyId)?.investorId;
    const invPrev = byId("properties", prev.propertyId)?.investorId;
    const lockedMonths = new Set(S.data.settlements.filter((s) => s.status === "LOCKED" && (s.investorId === inv || s.investorId === invPrev)).map((s) => s.month));
    const deltas = D.lockedMonthDeltas(D.splitNights(prev), D.splitNights(next), lockedMonths);
    for (const d of deltas) {
      const invOf = byId("properties", d.propertyId)?.investorId;
      if (!isLocked(invOf, d.month)) continue;
      let applied = D.nextMonth(d.month);
      while (isLocked(invOf, applied)) applied = D.nextMonth(applied);
      await save("adjustments", {
        id: uid("adj"), propertyId: d.propertyId, appliedMonth: applied, originalMonth: d.month, bookingId: next.id,
        amount: d.delta, reason: reason || "Đơn thay đổi sau khi tháng đã khóa", createdAt: nowVN(), acknowledged: false,
      });
    }
  }

  const oldKey = prev ? bucketId(prev) : null;
  const newKey = bucketId(next);
  if (oldKey && oldKey !== newKey) {
    const ob = byId("bookings", oldKey);
    if (ob) await save("bookings", { ...ob, items: ob.items.filter((x) => x.id !== next.id) });
  }
  const nb = byId("bookings", newKey) || { id: newKey, propertyId: next.propertyId, month: next.checkIn.slice(0, 7), items: [] };
  const items = nb.items.filter((x) => x.id !== next.id);
  items.push(next);
  items.sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  await save("bookings", { ...nb, items });
}

function pickLog(b) {
  return { roomId: b.roomId, checkIn: b.checkIn, checkOut: b.checkOut, grossAmount: b.grossAmount, commissionAmount: b.commissionAmount, netAmount: b.netAmount, status: b.status };
}

/** Nhập nhiều đơn một lượt (đồng bộ Dayladau): cùng quy tắc log + điều chỉnh như saveBooking, gom ghi theo tài liệu tháng. */
export async function importBookings(list, changedBy, reason = "") {
  const buckets = new Map(S.data.bookings.map((b) => [b.id, { ...b, items: [...(b.items || [])] }]));
  const touched = new Set();
  const adjs = [];
  let created = 0, updated = 0;
  for (let next of list) {
    const prev = bookingById(next.id);
    next = { ...next, log: [...(prev?.log || []), { at: nowVN(), by: changedBy, reason, before: prev ? pickLog(prev) : null, after: pickLog(next) }] };
    if (prev) {
      updated++;
      const invs = [byId("properties", next.propertyId)?.investorId, byId("properties", prev.propertyId)?.investorId];
      const lockedMonths = new Set(S.data.settlements.filter((s) => s.status === "LOCKED" && invs.includes(s.investorId)).map((s) => s.month));
      for (const d of D.lockedMonthDeltas(D.splitNights(prev), D.splitNights(next), lockedMonths)) {
        const invOf = byId("properties", d.propertyId)?.investorId;
        if (!isLocked(invOf, d.month)) continue;
        let applied = D.nextMonth(d.month);
        while (isLocked(invOf, applied)) applied = D.nextMonth(applied);
        adjs.push({ id: uid("adj"), propertyId: d.propertyId, appliedMonth: applied, originalMonth: d.month, bookingId: next.id, amount: d.delta, reason: reason || "Đơn thay đổi sau khi tháng đã khóa", createdAt: nowVN(), acknowledged: false });
      }
      const ok = bucketId(prev);
      if (ok !== bucketId(next) && buckets.has(ok)) {
        const b = buckets.get(ok);
        b.items = b.items.filter((x) => x.id !== next.id);
        touched.add(ok);
      }
    } else created++;
    const key = bucketId(next);
    const b = buckets.get(key) || { id: key, propertyId: next.propertyId, month: next.checkIn.slice(0, 7), items: [] };
    b.items = b.items.filter((x) => x.id !== next.id);
    b.items.push(next);
    buckets.set(key, b);
    touched.add(key);
  }
  for (const key of touched) {
    const b = buckets.get(key);
    b.items.sort((x, y) => x.checkIn.localeCompare(y.checkIn));
    await save("bookings", b);
  }
  for (const a of adjs) await save("adjustments", a);
  return { created, updated, adjustments: adjs.length };
}

// ---------- Xuất file ----------
export async function exportCSV(filename, rows) {
  const csv = "﻿" + rows.map((r) => r.map((c) => {
    const s = String(c ?? "");
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\r\n");
  if (!S.downloads) { toast("Trang này chưa được cấp quyền tải file."); return; }
  try {
    await S.downloads.save({ filename, data: new Blob([csv], { type: "text/csv;charset=utf-8" }) });
    toast(`Đã tải ${filename}`);
  } catch (e) {
    if (e?.code !== "declined") toast("Không tải được file. Thử lại sau.");
  }
}

// ---------- Ảnh ----------
export async function uploadPhoto(file) {
  if (!S.assets) throw new Error("no-assets");
  const blob = await compressImage(file);
  const res = await S.assets.upload(blob);
  return res.id;
}
export const photoUrl = (id) => `/_blob/${id}`;

async function compressImage(file) {
  if (!file.type.startsWith("image/") || file.type === "image/svg+xml") return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob((b) => res(b || file), "image/jpeg", 0.82));
  } catch { return file; }
}

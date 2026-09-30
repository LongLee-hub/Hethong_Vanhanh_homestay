// @ts-nocheck
import {
  D, S, esc, vnd, dvn, mvn, can, role, me, byId, config, allRooms, allBookings, bookingById, propName, staffName,
  allowedPropertyIds, isPropLocked, isLocked, isAnyLocked, isCommonFinalized, nowVN, TASK_TYPE, TASK_STATUS, PRIORITY, ROLE_LABEL,
  photoUrl,
} from "./core";
import { pill, chColor } from "./views";
import { statusPill } from "./views2";

export function openModal(kind, props = {}) { S.modal = { kind, ...props }; renderModal(); }
export function closeModal() { S.modal = null; renderModal(); }

const shell = (title, body, footer = "") => `<div class="overlay" data-act="modal-bg"><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
  <header><h2>${esc(title)}</h2><button class="x" data-act="modal-close" aria-label="Đóng">×</button></header>
  <div class="body">${body}</div>${footer ? `<footer>${footer}</footer>` : ""}</div></div>`;

const propOptions = (sel, allowCommon = false) => {
  const pids = allowedPropertyIds();
  return (allowCommon ? `<option value="__common" ${sel === null ? "selected" : ""}>Chi phí chung (toàn hệ thống)</option>` : "") +
    S.data.properties.filter((p) => pids.includes(p.id)).map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)}</option>`).join("");
};

export function renderModal() {
  const el = document.getElementById("modal");
  const m = S.modal;
  if (!m) { el.innerHTML = ""; return; }
  const fn = { booking: bookingDetail, bookingForm, expenseForm, task: taskDetail, taskForm, unlock: unlockForm, lock: lockForm, propForm, invForm, staffForm }[m.kind];
  el.innerHTML = fn ? fn(m) : "";
  const first = el.querySelector("input:not([type=checkbox]),select,textarea");
  if (first && m.kind.endsWith("Form")) first.focus();
}

// ---------- Đặt phòng ----------
function bookingDetail({ id }) {
  const b = bookingById(id);
  if (!b) return shell("Đơn không còn tồn tại", "<p>Đơn này đã bị xóa.</p>");
  const showAmt = can("bookingAmounts");
  const nights = b.status === "CANCELLED" && !b.netAmount ? [] : D.splitNights(b);
  const byMonth = {};
  for (const n of nights) byMonth[n.nightDate.slice(0, 7)] = (byMonth[n.nightDate.slice(0, 7)] || 0) + n.netAmount;
  const room = allRooms().find((r) => r.id === b.roomId);
  const lockedTouch = nights.some((n) => isPropLocked(b.propertyId, n.nightDate.slice(0, 7)));
  const canEditManual = b.source === "MANUAL" && can("createBooking") && !lockedTouch;
  const log = (b.log || []).slice().reverse();
  const fmtLog = (e) => {
    if (!e.before) return "Tạo đơn";
    const ch = Object.keys(e.after).filter((k) => JSON.stringify(e.after[k]) !== JSON.stringify(e.before[k]));
    return ch.map((k) => `${k}: ${esc(fmtVal(k, e.before[k]))} → ${esc(fmtVal(k, e.after[k]))}`).join("; ") || "Không đổi";
  };
  const body = `
    <div class="row"><span class="dot" style="background:${chColor(b.channel)}"></span><b>${esc(b.channel)}</b> ${b.status === "CANCELLED" ? pill("Đã hủy", "bad") : pill("Xác nhận", "ok")} ${b.source === "MANUAL" ? pill("Ngoài OTA") : pill("Dayladau · chỉ đọc")}</div>
    <div class="form-grid small">
      <div><div class="lbl">Khách</div>${esc(b.guestName || "—")}</div>
      <div><div class="lbl">Mã đơn</div>${esc(b.externalId || b.id)}</div>
      <div><div class="lbl">Cơ sở · Phòng</div>${esc(propName(b.propertyId))} · ${esc(room?.name || "?")}</div>
      <div><div class="lbl">Lưu trú</div>${dvn(b.checkIn)} → ${dvn(b.checkOut)} (${D.diffDays(b.checkOut, b.checkIn)} đêm)</div>
      <div><div class="lbl">Ngày đặt</div>${b.bookedAt ? dvn(b.bookedAt) + ` · trước ${D.diffDays(b.checkIn, b.bookedAt)} ngày` : "—"}</div>
      ${b.source === "MANUAL" ? `<div><div class="lbl">Chứng từ chuyển khoản</div>${esc(b.transferProof || "—")}</div>` : ""}
    </div>
    ${(b.proofIds || []).length ? `<div class="thumbs">${b.proofIds.map((p) => `<img src="${photoUrl(p)}" alt="Ảnh chuyển khoản">`).join("")}</div>` : ""}
    ${showAmt ? `<div class="tbl-wrap"><table><tbody>
      <tr><td>Gross</td><td class="n">${vnd(b.grossAmount)}</td></tr>
      <tr><td>Hoa hồng OTA</td><td class="n">− ${vnd(b.commissionAmount)}</td></tr>
      <tr class="total"><td>Net (dùng cho mọi báo cáo)</td><td class="n">${vnd(b.netAmount)}</td></tr></tbody></table></div>
    <div><div class="lbl" style="margin-bottom:4px">Doanh thu phân bổ theo tháng</div>
      ${Object.entries(byMonth).map(([m, v]) => `<div class="row small"><span>${mvn(m)}${isPropLocked(b.propertyId, m) ? " " + pill("đã khóa", "ok") : ""}</span><span class="spacer"></span><span class="num">${vnd(v)}</span></div>`).join("") || `<div class="small muted">Không có đêm nào (đơn hủy không phí).</div>`}
      <details class="small" style="margin-top:6px"><summary>Xem từng đêm</summary>${nights.map((n) => `<div class="row"><span class="num">${dvn(n.nightDate)}</span><span class="spacer"></span><span class="num">${vnd(n.netAmount)}</span></div>`).join("")}</details>
    </div>` : ""}
    ${log.length ? `<div><div class="lbl" style="margin-bottom:4px">Lịch sử thay đổi</div>${log.map((e) => `<div class="small"><span class="muted">${esc(e.at.replace("T", " "))} · ${esc(e.by)}</span> — ${fmtLog(e)}${e.reason ? ` <i>(${esc(e.reason)})</i>` : ""}</div>`).join("")}</div>` : ""}
    ${lockedTouch && b.source === "MANUAL" ? `<div class="banner info">Đơn có đêm thuộc tháng đã khóa sổ nên không sửa trực tiếp được. Admin mở khóa tháng nếu cần sửa.</div>` : ""}
    ${S.modal.simulate ? `<div class="banner">Mô phỏng Dayladau gửi thay đổi cho đơn này. Nếu đơn có đêm thuộc tháng đã khóa, hệ thống tạo khoản điều chỉnh ghi vào tháng mở kế tiếp.</div>` : ""}`;
  const footer = [
    canEditManual ? `<button class="btn" data-act="booking-edit" data-id="${b.id}">Sửa đơn</button>` : "",
    b.source === "DAYLADAU" && can("admin") && b.status === "CONFIRMED" ? `<button class="btn danger" data-act="booking-sim-cancel" data-id="${b.id}" title="Thay cho việc Dayladau báo khách hủy">Mô phỏng: Dayladau báo hủy</button>` : "",
    `<button class="btn primary" data-act="modal-close">Đóng</button>`,
  ].join("");
  return shell(`Đơn ${b.guestName || ""}`, body, footer);
}
function fmtVal(k, v) {
  if (["grossAmount", "commissionAmount", "netAmount"].includes(k)) return vnd(v);
  if (k === "roomId") return allRooms().find((r) => r.id === v)?.name || v;
  if (["checkIn", "checkOut"].includes(k)) return dvn(v);
  return String(v);
}

function bookingForm({ id }) {
  const b = id ? bookingById(id) : null;
  const pids = allowedPropertyIds();
  const propId = b?.propertyId || S.modal.propId || (S.prop !== "all" && pids.includes(S.prop) ? S.prop : pids[0]);
  const rooms = allRooms().filter((r) => r.propertyId === propId && !r.closedOn);
  const body = `<div class="form-grid">
    <label class="field"><span>Cơ sở</span><select id="bf-prop" data-act-change="bf-prop">${propOptions(propId)}</select></label>
    <label class="field"><span>Phòng</span><select id="bf-room">${rooms.map((r) => `<option value="${r.id}" ${r.id === b?.roomId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Tên khách</span><input type="text" id="bf-guest" value="${esc(b?.guestName || "")}" required></label>
    <label class="field"><span>Ngày khách đặt</span><input type="date" id="bf-booked" value="${esc(b?.bookedAt || S.today)}"></label>
    <label class="field"><span>Nhận phòng</span><input type="date" id="bf-in" value="${esc(b?.checkIn || S.today)}"></label>
    <label class="field"><span>Trả phòng</span><input type="date" id="bf-out" value="${esc(b?.checkOut || D.addDays(S.today, 1))}"></label>
    <label class="field"><span>Số tiền khách trả (VND)</span><input type="text" inputmode="numeric" id="bf-amount" value="${b ? b.netAmount : ""}" placeholder="1.500.000"></label>
    <label class="field"><span>Trạng thái</span><select id="bf-status"><option value="CONFIRMED">Xác nhận</option><option value="CANCELLED" ${b?.status === "CANCELLED" ? "selected" : ""}>Đã hủy</option></select></label>
    <label class="field full"><span>Chứng từ chuyển khoản (bắt buộc: số tham chiếu và/hoặc ảnh)</span><input type="text" id="bf-proof" value="${esc(b?.transferProof || "")}" placeholder="VD: CK Vietcombank 29/09, nội dung LOCI P201"></label>
    ${S.assets ? `<label class="field full"><span>Ảnh chuyển khoản</span><input type="file" id="bf-photo" accept="image/*"></label>` : ""}
    ${b ? `<label class="field full"><span>Lý do sửa</span><input type="text" id="bf-reason" placeholder="VD: khách đổi ngày"></label>` : ""}
    <p class="hint full">Đơn ngoài OTA không có hoa hồng: số tiền khách trả là doanh thu net, chia đều cho các đêm.</p>
    <p class="err full" id="bf-err"></p>
  </div>`;
  return shell(b ? "Sửa đơn ngoài OTA" : "Tạo đơn ngoài OTA", body, `<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="booking-save" data-id="${b?.id || ""}">Lưu đơn</button>`);
}

// ---------- Chi phí ----------
function expenseForm({ id, common, taskId }) {
  const e = id ? byId("expenses", id) : null;
  const isCommon = e ? e.propertyId === null : !!common;
  const task = taskId ? byId("tasks", taskId) : null;
  const propSel = e ? e.propertyId : isCommon ? null : task?.propertyId || (S.prop !== "all" ? S.prop : allowedPropertyIds()[0]);
  const cats = S.data.categories.filter((c) => c.active !== false);
  const defCat = e?.categoryId || (task?.type === "MAINTENANCE" ? "cat-maint" : task?.type === "PURCHASE" ? "cat-supply" : isCommon ? "cat-salary" : cats[0]?.id);
  const body = `<div class="form-grid">
    <label class="field full"><span>Cơ sở</span><select id="ef-prop">${propOptions(propSel, can("commonCost"))}</select></label>
    <label class="field"><span>Loại chi phí</span><select id="ef-cat">${cats.map((c) => `<option value="${c.id}" ${c.id === defCat ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Số tiền (VND)</span><input type="text" inputmode="numeric" id="ef-amount" value="${e ? e.amount : ""}" placeholder="450.000"></label>
    <label class="field"><span>Tháng hạch toán</span><input type="month" id="ef-month" value="${esc(e?.month || S.month)}"></label>
    <label class="field"><span>Ngày phát sinh</span><input type="date" id="ef-date" value="${esc(e?.incurredOn || (S.month === S.today.slice(0, 7) ? S.today : D.lastDay(S.month)))}"></label>
    <label class="field full"><span>Mô tả</span><input type="text" id="ef-desc" value="${esc(e?.description || (task ? task.title : ""))}" placeholder="VD: Thay vòi sen phòng P201"></label>
    <label class="field"><span>Thanh toán</span><select id="ef-pay"><option value="UNPAID">Chưa thanh toán</option><option value="PAID" ${e?.paymentStatus === "PAID" ? "selected" : ""}>Đã thanh toán</option></select></label>
    ${S.assets ? `<label class="field"><span>Ảnh hóa đơn</span><input type="file" id="ef-photo" accept="image/*,application/pdf"></label>` : ""}
    ${task ? `<p class="hint full">Gắn với công việc: ${esc(task.title)}</p>` : ""}
    <p class="hint full">Chi phí tính vào tháng hạch toán, không theo ngày thanh toán. Trạng thái thanh toán chỉ để theo dõi NĐT đã trả hay chưa.</p>
    <p class="err full" id="ef-err"></p>
  </div>`;
  return shell(e ? "Sửa chi phí" : "Nhập chi phí", body, `${e ? `<button class="btn danger" data-act="expense-del" data-id="${e.id}">Xóa</button><span class="spacer"></span>` : ""}<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="expense-save" data-id="${e?.id || ""}" data-task="${taskId || ""}">Lưu</button>`);
}

// ---------- Công việc ----------
function taskDetail({ id }) {
  const t = byId("tasks", id);
  if (!t) return shell("Việc không còn tồn tại", "");
  const mine = t.assigneeId === me().id || can("assign");
  const room = t.roomId ? allRooms().find((r) => r.id === t.roomId)?.name : "";
  const needPhoto = ["CLEANING", "MAINTENANCE"].includes(t.type);
  const linkedExp = S.data.expenses.filter((e) => e.taskId === t.id);
  const body = `
    <div class="row">${pill(TASK_TYPE[t.type])} ${statusPill(t)} ${pill("Ưu tiên " + PRIORITY[t.priority].toLowerCase(), t.priority === "HIGH" || t.priority === "URGENT" ? "bad" : "")}</div>
    <div class="form-grid small">
      <div><div class="lbl">Cơ sở</div>${esc(propName(t.propertyId))}${room ? " · " + esc(room) : ""}</div>
      <div><div class="lbl">Hạn chót</div>${dvn(t.dueAt)} ${t.dueAt.slice(11, 16)}</div>
      <div><div class="lbl">Người làm</div>${esc(staffName(t.assigneeId))}</div>
      <div><div class="lbl">Người giao</div>${esc(staffName(t.assignedById))}</div>
    </div>
    ${t.description ? `<p class="small">${esc(t.description)}</p>` : ""}
    ${t.checklist ? `<div class="stack" style="gap:6px"><div class="lbl">Checklist (${t.checklist.filter((c) => c.done).length}/${t.checklist.length})</div>
      ${t.checklist.map((c, i) => `<label class="check-item"><input type="checkbox" id="cl-${i}" data-act="task-check" data-id="${t.id}" data-i="${i}" ${c.done ? "checked" : ""} ${mine && t.status !== "DONE" ? "" : "disabled"}><span>${esc(c.item)}</span></label>`).join("")}</div>` : ""}
    <div class="stack" style="gap:6px"><div class="lbl">Ảnh nghiệm thu ${needPhoto ? "(bắt buộc khi hoàn thành)" : ""}</div>
      <div class="thumbs">${(t.photoIds || []).map((p) => `<img src="${photoUrl(p)}" alt="Ảnh nghiệm thu">`).join("") || `<span class="small muted">Chưa có ảnh.</span>`}</div>
      ${mine && t.status !== "DONE" ? (S.assets ? `<input type="file" id="task-photo" accept="image/*" data-act-change="task-photo" data-id="${t.id}">` : `<label class="field"><span>Ghi chú nghiệm thu (trang này chưa bật tải ảnh)</span><input type="text" id="task-note" value="${esc(t.proofNote || "")}" placeholder="VD: đã gửi ảnh vào nhóm Zalo lúc 12:40"></label>`) : ""}
      ${t.proofNote ? `<div class="small">${esc(t.proofNote)}</div>` : ""}
    </div>
    ${linkedExp.length ? `<div class="small"><div class="lbl">Chi phí gắn việc</div>${linkedExp.map((e) => `${esc(e.description)}: <b>${vnd(e.amount)}</b>`).join("<br>")}</div>` : ""}
    <p class="err" id="task-err"></p>`;
  const btn = (s, label, cls = "") => `<button class="btn ${cls}" data-act="task-status" data-id="${t.id}" data-s="${s}">${label}</button>`;
  const footer = [
    ["MAINTENANCE", "PURCHASE"].includes(t.type) && can("editExpense") ? `<button class="btn" data-act="expense-new" data-task="${t.id}">+ Thêm chi phí</button>` : "",
    can("assign") ? `<button class="btn" data-act="task-edit" data-id="${t.id}">Sửa</button>` : "",
    `<span class="spacer"></span>`,
    mine && t.status === "TODO" ? btn("IN_PROGRESS", "Bắt đầu") : "",
    mine && ["TODO", "IN_PROGRESS"].includes(t.status) ? btn("DONE", "Hoàn thành", "primary") : "",
    mine && t.status === "DONE" && can("assign") ? btn("IN_PROGRESS", "Mở lại") : "",
    can("assign") && t.status !== "CANCELLED" && t.status !== "DONE" ? btn("CANCELLED", "Hủy việc", "danger") : "",
  ].join("");
  return shell(t.title, body, footer);
}

function taskForm({ id }) {
  const t = id ? byId("tasks", id) : null;
  const pids = allowedPropertyIds();
  const propId = t?.propertyId || S.modal.propId || (S.prop !== "all" ? S.prop : pids[0]);
  const rooms = allRooms().filter((r) => r.propertyId === propId);
  const people = S.data.staff.filter((s) => ["MANAGER", "HOUSEKEEPER", "ACCOUNTANT", "ADMIN"].includes(s.role) && s.active !== false && (s.role === "ADMIN" || (s.propertyIds || []).includes(propId)));
  const body = `<div class="form-grid">
    <label class="field full"><span>Tên việc</span><input type="text" id="tf-title" value="${esc(t?.title || "")}" placeholder="VD: Thay bóng đèn nhà tắm P102"></label>
    <label class="field"><span>Loại</span><select id="tf-type">${Object.entries(TASK_TYPE).map(([k, v]) => `<option value="${k}" ${k === (t?.type || "MAINTENANCE") ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label class="field"><span>Ưu tiên</span><select id="tf-pri">${Object.entries(PRIORITY).map(([k, v]) => `<option value="${k}" ${k === (t?.priority || "MEDIUM") ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    <label class="field"><span>Cơ sở</span><select id="tf-prop" data-act-change="tf-prop">${propOptions(propId)}</select></label>
    <label class="field"><span>Phòng</span><select id="tf-room"><option value="">Không gắn phòng</option>${rooms.map((r) => `<option value="${r.id}" ${r.id === t?.roomId ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Người làm</span><select id="tf-who">${people.map((s) => `<option value="${s.id}" ${s.id === t?.assigneeId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
    <label class="field"><span>Hạn chót</span><input type="datetime-local" id="tf-due" value="${esc(t?.dueAt || S.today + "T17:00")}"></label>
    <label class="field full"><span>Mô tả</span><textarea id="tf-desc">${esc(t?.description || "")}</textarea></label>
    <label class="field full"><span>Lặp lại (việc định kỳ)</span><select id="tf-rec"><option value="">Không lặp</option>${[1, 5, 10, 15, 20, 25].map((d) => `<option value="monthly:${d}" ${t?.recurrenceRule === `monthly:${d}` ? "selected" : ""}>Hằng tháng, ngày ${d}</option>`).join("")}</select></label>
    <p class="err full" id="tf-err"></p>
  </div>`;
  return shell(t ? "Sửa việc" : "Giao việc", body, `<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="task-save" data-id="${t?.id || ""}">Lưu</button>`);
}

// ---------- Khóa sổ ----------
function lockForm({ inv }) {
  return shell(`Khóa sổ ${mvn(S.month).toLowerCase()}`, `<p>Sau khi khóa, số liệu quyết toán của <b>${esc(byId("investors", inv)?.name)}</b> được chốt và không tính lại. Chi phí thuộc tháng này không sửa được nữa. Thay đổi đơn về sau sẽ tạo khoản điều chỉnh ghi vào tháng mở kế tiếp.</p>`,
    `<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="settle-lock-confirm" data-inv="${inv}">Khóa sổ</button>`);
}
function unlockForm({ inv }) {
  return shell("Mở khóa quyết toán", `<p>Mở khóa ${mvn(S.month).toLowerCase()} của <b>${esc(byId("investors", inv)?.name)}</b>. Số liệu sẽ được tính lại từ dữ liệu hiện tại.</p>
    <label class="field"><span>Lý do (bắt buộc, được ghi lại)</span><input type="text" id="unlock-reason" placeholder="VD: kế toán nhập thiếu hóa đơn điện"></label><p class="err" id="unlock-err"></p>`,
    `<button class="btn" data-act="modal-close">Hủy</button><button class="btn danger" data-act="settle-unlock-confirm" data-inv="${inv}">Mở khóa</button>`);
}

// ---------- Quản trị ----------
function propForm({ id }) {
  const p = id ? byId("properties", id) : null;
  const rooms = S.modal.rooms || (p?.rooms || []).map((r) => ({ ...r }));
  S.modal.rooms = rooms;
  const body = `<div class="form-grid">
    <label class="field"><span>Tên cơ sở</span><input type="text" id="pf-name" value="${esc(p?.name || "")}"></label>
    <label class="field"><span>Nhà đầu tư</span><select id="pf-inv">${S.data.investors.map((i) => `<option value="${i.id}" ${i.id === p?.investorId ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></label>
    <label class="field full"><span>Địa chỉ</span><input type="text" id="pf-addr" value="${esc(p?.address || "")}"></label>
    <label class="field"><span>Vốn đầu tư (VND)</span><input type="text" inputmode="numeric" id="pf-invest" value="${p?.investmentAmount ?? ""}"></label>
    <label class="field"><span>Bắt đầu tính hoàn vốn</span><input type="month" id="pf-start" value="${esc(p?.investmentStartMonth || S.month)}"></label>
    <label class="field"><span>Chi phí cố định dự kiến / tháng</span><input type="text" inputmode="numeric" id="pf-fixed" value="${p?.fixedCostMonthly ?? ""}"></label>
    <label class="field"><span>Chi phí biến đổi / đêm có khách</span><input type="text" inputmode="numeric" id="pf-var" value="${p?.variableCostPerNight ?? ""}"></label>
    <label class="field"><span>Ngưỡng cảnh báo công suất (%)</span><input type="number" id="pf-kpi" value="${p?.occupancyKpiPct ?? 70}"></label>
  </div>
  <div class="stack" style="gap:8px"><div class="row"><span class="lbl">Phòng</span><span class="spacer"></span><button class="btn sm" data-act="pf-room-add">+ Thêm phòng</button></div>
    ${rooms.map((r, i) => `<div class="form-grid" style="grid-template-columns:1fr 1fr 1fr 1fr;align-items:end">
      <label class="field"><span>Tên</span><input type="text" id="pr-name-${i}" value="${esc(r.name)}"></label>
      <label class="field"><span>Mở từ</span><input type="date" id="pr-open-${i}" value="${esc(r.openedOn || S.today)}"></label>
      <label class="field"><span>Đóng từ</span><input type="date" id="pr-close-${i}" value="${esc(r.closedOn || "")}"></label>
      <label class="field"><span>Mã phòng Dayladau</span><input type="text" id="pr-dld-${i}" value="${esc(r.dayladauRoomId || "")}"></label>
    </div>`).join("") || `<div class="small muted">Chưa có phòng.</div>`}
    <p class="hint">Không xóa phòng đã có đơn; đặt ngày đóng để ngừng tính đêm có sẵn và chi phí chung.</p></div>
  <p class="err" id="pf-err"></p>`;
  return shell(p ? `Sửa ${p.name}` : "Thêm cơ sở", body, `<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="prop-save" data-id="${p?.id || ""}">Lưu</button>`);
}

function invForm({ id }) {
  const i = id ? byId("investors", id) : null;
  return shell(i ? "Sửa nhà đầu tư" : "Thêm nhà đầu tư", `<div class="form-grid">
    <label class="field full"><span>Tên</span><input type="text" id="if-name" value="${esc(i?.name || "")}"></label>
    <p class="hint full">Host ID và access token Dayladau nhập ở Quản trị → Đồng bộ Dayladau sau khi lưu nhà đầu tư.</p>
    <p class="err full" id="if-err"></p></div>`,
    `<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="inv-save" data-id="${i?.id || ""}">Lưu</button>`);
}

function staffForm({ id }) {
  const s = id ? byId("staff", id) : null;
  const r = S.modal.role || s?.role || "HOUSEKEEPER";
  return shell(s ? "Sửa người dùng" : "Thêm người dùng", `<div class="form-grid">
    <label class="field"><span>Tên</span><input type="text" id="sf-name" value="${esc(s?.name || "")}"></label>
    <label class="field"><span>Vai trò</span><select id="sf-role" data-act-change="sf-role">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === r ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    ${r === "INVESTOR" ? `<label class="field full"><span>Là nhà đầu tư</span><select id="sf-inv">${S.data.investors.map((i) => `<option value="${i.id}" ${i.id === s?.investorId ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></label>` : ""}
    ${["MANAGER", "ACCOUNTANT", "HOUSEKEEPER"].includes(r) ? `<div class="field full"><span>Cơ sở được truy cập</span><div class="chips">${S.data.properties.map((p) => `<label class="chip"><input type="checkbox" id="sf-p-${p.id}" value="${p.id}" ${(s?.propertyIds || []).includes(p.id) ? "checked" : ""}> ${esc(p.name)}</label>`).join("")}</div></div>` : ""}
    <label class="field"><span>Trạng thái</span><select id="sf-active"><option value="1">Hoạt động</option><option value="0" ${s?.active === false ? "selected" : ""}>Ngừng</option></select></label>
    <p class="err full" id="sf-err"></p></div>`,
    `<button class="btn" data-act="modal-close">Hủy</button><button class="btn primary" data-act="staff-save" data-id="${s?.id || ""}">Lưu</button>`);
}

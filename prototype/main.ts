// @ts-nocheck
import {
  D, S, esc, vnd, mvn, can, role, me, byId, config, allRooms, allBookings, bookingById, propName, staffName, allowedPropertyIds,
  visiblePropertyIds, isPropLocked, isLocked, isAnyLocked, isCommonFinalized, settlement, nowVN, uid, parseMoney, save, remove,
  saveBooking, setMe, setRoute, boot, onChange, isLoaded, isEmpty, loadSample, clearSample, toast, exportCSV, uploadPhoto,
  currentMonth, TASK_TYPE,
} from "./core";
import { layout, navItems, viewDashboard, viewBookings, viewExpenses, viewSettle, empty } from "./views";
import { viewTasks, viewAttendance, viewReports, viewAdmin, attendanceRows } from "./views2";
import { openModal, closeModal, renderModal } from "./modals";
import { DLD, addPasted, loadToken, mapListing, runImport, saveConnection } from "./dayladau";

const $ = (id) => document.getElementById(id);
const val = (id) => $(id)?.value ?? "";

// ---------- Render ----------
function render() {
  const root = $("root");
  if (!isLoaded()) { root.innerHTML = `<div class="empty" style="padding-top:20vh">Đang tải dữ liệu…</div>`; return; }
  if (isEmpty()) {
    root.innerHTML = `<div class="empty" style="padding-top:14vh;max-width:520px;margin:0 auto">
      <h1>LOCI Homestay Manager</h1>
      <p>Chưa có dữ liệu. Nạp bộ dữ liệu mẫu (3 cơ sở, 2 nhà đầu tư, đơn từ tháng 7 đến tháng 11) để xem thử mọi màn hình, rồi xóa đi khi nhập dữ liệu thật.</p>
      <button class="btn primary" data-act="sample-load">Nạp dữ liệu mẫu</button></div>`;
    return;
  }
  const items = navItems().map((x) => x[0]);
  if (!items.includes(S.route)) S.route = items[0];
  const view = { dashboard: viewDashboard, bookings: viewBookings, expenses: viewExpenses, settle: viewSettle, tasks: viewTasks, attendance: viewAttendance, reports: viewReports, admin: viewAdmin }[S.route];
  // Giữ vị trí con trỏ khi đang gõ ô tìm kiếm
  const active = document.activeElement;
  const activeId = active?.id;
  const selStart = active?.selectionStart;
  let content;
  try { content = view(); } catch (e) { console.error(e); content = `<div class="banner bad">Không hiển thị được màn hình này: ${esc(e.message)}</div>`; }
  root.innerHTML = layout(content);
  if (activeId && $(activeId) && active.tagName === "INPUT" && active.type === "search") {
    const el = $(activeId); el.focus(); try { el.setSelectionRange(selStart, selStart); } catch {}
  }
}
onChange(() => { render(); if (S.modal?.live) renderModal(); });

// ---------- Sự kiện ----------
document.addEventListener("click", async (ev) => {
  const t = ev.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "modal-bg" && ev.target !== t) return;
  const fn = ACT[act];
  if (!fn) return;
  if (t.tagName === "BUTTON" || t.tagName === "TR") ev.preventDefault();
  try { await fn(t.dataset, t, ev); } catch (e) { console.error(e); }
});
document.addEventListener("change", async (ev) => {
  const t = ev.target;
  if (t.dataset.on === "who") { setMe(t.value); return; }
  if (t.dataset.on === "ui" && t.type !== "search") { S.ui[t.dataset.k] = t.value; render(); return; }
  if (t.dataset.actChange && CHG[t.dataset.actChange]) await CHG[t.dataset.actChange](t);
});
let searchT;
document.addEventListener("input", (ev) => {
  const t = ev.target;
  if (t.dataset.on === "ui" && t.type === "search") {
    clearTimeout(searchT);
    searchT = setTimeout(() => { S.ui[t.dataset.k] = t.value; render(); }, 180);
  }
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && S.modal) closeModal(); });

const CHG = {
  "dld-file": async (t) => {
    const f = t.files?.[0];
    if (!f) return;
    try { const r = addPasted(await f.text()); DLD.error = ""; toast(`Đọc ${r.count} đơn (${r.added} đơn mới so với lần đọc trước)`); }
    catch (e) { DLD.error = e.message; }
    render();
  },
  "dld-map": async (t) => {
    try { await mapListing(DLD.invId, t.dataset.key, t.value || null); toast(t.value ? "Đã gắn listing với phòng" : "Đã bỏ gắn"); }
    catch (e) { toast(e.message); }
  },
  "bf-prop": (t) => { S.modal.propId = t.value; renderModal(); },
  "tf-prop": (t) => { S.modal.propId = t.value; renderModal(); },
  "sf-role": (t) => { S.modal.role = t.value; renderModal(); },
  "task-photo": async (t) => {
    const f = t.files?.[0];
    if (!f) return;
    const task = byId("tasks", t.dataset.id);
    toast("Đang tải ảnh…");
    try {
      const id = await uploadPhoto(f);
      await save("tasks", { ...task, photoIds: [...(task.photoIds || []), id] });
      renderModal();
      toast("Đã thêm ảnh nghiệm thu");
    } catch { toast("Không tải được ảnh. Thử ảnh nhỏ hơn hoặc thử lại."); }
  },
};

function err(id, msg) { const el = $(id); if (el) el.textContent = msg; return false; }

const ACT = {
  nav: (d) => setRoute(d.r),
  prop: (d) => { S.prop = d.id; render(); },
  month: (d) => {
    const n = Number(d.d);
    S.month = n > 0 ? D.nextMonth(S.month) : D.prevMonth(S.month);
    S.ui.exSel = [];
    render();
  },
  "month-now": () => { S.month = currentMonth(); render(); },
  ui: (d) => { S.ui[d.k] = d.v; if (d.k === "exTab") S.ui.exSel = []; render(); },
  "modal-close": () => closeModal(),
  "modal-bg": () => closeModal(),

  "sample-load": async (d, t) => {
    t.disabled = true; t.textContent = "Đang nạp…";
    await loadSample();
    toast("Đã nạp dữ liệu mẫu");
  },
  "sample-clear": async () => { S.ui.confirmClear = ""; await clearSample(); toast("Đã xóa dữ liệu mẫu"); },

  // ----- Đặt phòng -----
  "booking-open": (d) => openModal("booking", { id: d.id, live: true }),
  "booking-new": () => openModal("bookingForm", {}),
  "booking-edit": (d) => openModal("bookingForm", { id: d.id }),
  "booking-save": async (d) => {
    const prev = d.id ? bookingById(d.id) : null;
    const propertyId = val("bf-prop"), roomId = val("bf-room"), guest = val("bf-guest").trim();
    const checkIn = val("bf-in"), checkOut = val("bf-out"), amount = parseMoney(val("bf-amount"));
    const status = val("bf-status"), proof = val("bf-proof").trim();
    const file = $("bf-photo")?.files?.[0];
    if (!guest) return err("bf-err", "Nhập tên khách.");
    if (!roomId) return err("bf-err", "Cơ sở này chưa có phòng.");
    if (!checkIn || !checkOut || checkOut <= checkIn) return err("bf-err", "Ngày trả phòng phải sau ngày nhận phòng.");
    if (amount < 0) return err("bf-err", "Số tiền không hợp lệ.");
    if (!proof && !file && !(prev?.proofIds || []).length) return err("bf-err", "Đơn ngoài OTA bắt buộc có chứng từ chuyển khoản.");
    const clash = allBookings().find((b) => b.id !== d.id && b.roomId === roomId && b.status === "CONFIRMED" && b.checkIn < checkOut && b.checkOut > checkIn);
    if (clash && status === "CONFIRMED") return err("bf-err", `Phòng đã có khách ${clash.guestName} từ ${clash.checkIn.split("-").reverse().join("/")} đến ${clash.checkOut.split("-").reverse().join("/")}.`);
    const touchLocked = (b) => b && D.splitNights(b).some((n) => isPropLocked(b.propertyId, n.nightDate.slice(0, 7)));
    const next = {
      ...(prev || {}), id: prev?.id || uid("bk"), source: "MANUAL", externalId: null, propertyId, roomId, channel: "Trực tiếp",
      guestName: guest, bookedAt: val("bf-booked") || S.today, checkIn, checkOut, grossAmount: amount, commissionAmount: 0,
      netAmount: amount, status, transferProof: proof, proofIds: prev?.proofIds || [], createdById: prev?.createdById || me().id,
    };
    if (touchLocked(next)) return err("bf-err", "Đơn có đêm rơi vào tháng đã khóa sổ. Chọn ngày thuộc tháng còn mở.");
    if (file) {
      try { next.proofIds = [...next.proofIds, await uploadPhoto(file)]; } catch { return err("bf-err", "Không tải được ảnh chuyển khoản."); }
    }
    await saveBooking(next, me().name, prev ? val("bf-reason") : "");
    closeModal();
    toast(prev ? "Đã cập nhật đơn" : "Đã tạo đơn ngoài OTA");
  },
  "booking-sim-cancel": async (d) => {
    const b = bookingById(d.id);
    await saveBooking({ ...b, status: "CANCELLED", netAmount: 0 }, "SYNC", "Dayladau báo khách hủy (mô phỏng)");
    S.modal.simulate = true;
    renderModal();
    toast("Đã cập nhật đơn theo Dayladau");
  },
  "export-bookings": () => {
    const pids = visiblePropertyIds();
    const from = D.firstDay(S.month), to = D.lastDay(S.month);
    const rows = allBookings().filter((b) => pids.includes(b.propertyId) && b.checkIn <= to && b.checkOut > from);
    exportCSV(`dat-phong-${S.month}.csv`, [
      ["Mã đơn", "Nguồn", "Kênh", "Cơ sở", "Phòng", "Khách", "Ngày đặt", "Nhận phòng", "Trả phòng", "Số đêm", "Gross", "Hoa hồng", "Net", "Trạng thái"],
      ...rows.map((b) => [b.externalId || b.id, b.source, b.channel, propName(b.propertyId), allRooms().find((r) => r.id === b.roomId)?.name, b.guestName, b.bookedAt, b.checkIn, b.checkOut, D.diffDays(b.checkOut, b.checkIn), b.grossAmount, b.commissionAmount, b.netAmount, b.status]),
    ]);
  },

  // ----- Chi phí -----
  "expense-new": (d) => openModal("expenseForm", { common: d.common === "1", taskId: d.task || null }),
  "expense-edit": (d) => {
    const e = byId("expenses", d.id);
    if (e.propertyId ? isPropLocked(e.propertyId, e.month) : isAnyLocked(e.month)) return toast("Chi phí thuộc tháng đã khóa sổ, không sửa được.");
    openModal("expenseForm", { id: d.id });
  },
  "expense-save": async (d) => {
    const prev = d.id ? byId("expenses", d.id) : null;
    const propRaw = val("ef-prop");
    const propertyId = propRaw === "__common" ? null : propRaw;
    const amount = parseMoney(val("ef-amount"));
    const month = val("ef-month");
    const desc = val("ef-desc").trim();
    if (!amount || amount <= 0) return err("ef-err", "Nhập số tiền lớn hơn 0.");
    if (!/^\d{4}-\d{2}$/.test(month)) return err("ef-err", "Chọn tháng hạch toán.");
    if (!desc) return err("ef-err", "Nhập mô tả để kế toán và NĐT hiểu khoản chi.");
    if (propertyId ? isPropLocked(propertyId, month) : isAnyLocked(month)) return err("ef-err", `${mvn(month)} đã khóa sổ. Chọn tháng đang mở.`);
    if (propertyId === null && isCommonFinalized(month)) return err("ef-err", `Chi phí chung ${mvn(month).toLowerCase()} đã hoàn tất kê khai. Mở lại kê khai trước.`);
    const pay = val("ef-pay");
    const doc = {
      ...(prev || {}), id: prev?.id || uid("ex"), propertyId, categoryId: val("ef-cat"), month, incurredOn: val("ef-date") || D.firstDay(month),
      amount, description: desc, paymentStatus: pay, paidAt: pay === "PAID" ? prev?.paidAt || nowVN() : null,
      receiptIds: prev?.receiptIds || [], taskId: prev?.taskId || d.task || null, createdById: prev?.createdById || me().id,
    };
    const file = $("ef-photo")?.files?.[0];
    if (file) { try { doc.receiptIds = [...doc.receiptIds, await uploadPhoto(file)]; } catch { return err("ef-err", "Không tải được ảnh hóa đơn."); } }
    await save("expenses", doc);
    if (d.task) { openModal("task", { id: d.task, live: true }); } else closeModal();
    toast(prev ? "Đã cập nhật chi phí" : `Đã lưu ${vnd(amount)}`);
  },
  "expense-del": async (d) => { await remove("expenses", d.id); closeModal(); toast("Đã xóa chi phí"); },
  "expense-sel": (d, t) => {
    const s = new Set(S.ui.exSel || []);
    t.checked ? s.add(d.id) : s.delete(d.id);
    S.ui.exSel = [...s]; render();
  },
  "expense-selall": (d, t) => {
    const pids = visiblePropertyIds();
    S.ui.exSel = t.checked ? S.data.expenses.filter((e) => e.month === S.month && e.propertyId && pids.includes(e.propertyId) && e.paymentStatus === "UNPAID" && (!S.ui.exCat || e.categoryId === S.ui.exCat)).map((e) => e.id) : [];
    render();
  },
  "expense-markpaid": async () => {
    const ids = S.ui.exSel || [];
    for (const id of ids) { const e = byId("expenses", id); if (e) await save("expenses", { ...e, paymentStatus: "PAID", paidAt: nowVN() }); }
    S.ui.exSel = [];
    toast(`Đã đánh dấu ${ids.length} khoản là đã thanh toán`);
  },
  "common-finalize": async () => {
    await save("periods", { ...(byId("periods", S.month) || { id: S.month }), commonCostsFinalized: true, finalizedAt: nowVN(), finalizedBy: me().name });
    toast(`Đã hoàn tất kê khai chi phí chung ${mvn(S.month).toLowerCase()}`);
  },
  "common-reopen": async () => {
    await save("periods", { ...(byId("periods", S.month) || { id: S.month }), commonCostsFinalized: false });
    toast("Đã mở lại kê khai");
  },

  // ----- Quyết toán -----
  "settle-pick": (d) => { S.ui.stInv = d.inv; S.month = d.m; render(); },
  "settle-lock": (d) => openModal("lock", { inv: d.inv }),
  "settle-lock-confirm": async (d) => {
    const chk = D.canLockMonth(S.month, S.today, isCommonFinalized(S.month));
    if (!chk.ok) { closeModal(); return toast(chk.reason); }
    const s = settlement(d.inv, S.month);
    const prev = byId("settlements", `${d.inv}__${S.month}`);
    const { locked, ...data } = s;
    await save("settlements", { ...data, id: `${d.inv}__${S.month}`, investorId: d.inv, month: S.month, status: "LOCKED", lockedAt: nowVN(), lockedBy: me().name, unlockLog: prev?.unlockLog || [] });
    // Đánh dấu đã xem các khoản điều chỉnh đã được tính vào tháng này
    for (const a of S.data.adjustments.filter((a) => a.appliedMonth === S.month && !a.acknowledged)) await save("adjustments", { ...a, acknowledged: true });
    closeModal();
    toast(`Đã khóa sổ ${mvn(S.month).toLowerCase()}`);
  },
  "settle-unlock": (d) => openModal("unlock", { inv: d.inv }),
  "settle-unlock-confirm": async (d) => {
    const reason = val("unlock-reason").trim();
    if (!reason) return err("unlock-err", "Nhập lý do mở khóa.");
    const doc = byId("settlements", `${d.inv}__${S.month}`);
    await save("settlements", { id: doc.id, investorId: d.inv, month: S.month, status: "DRAFT", unlockLog: [...(doc.unlockLog || []), { at: nowVN(), by: me().name, reason }] });
    closeModal();
    toast("Đã mở khóa. Số liệu được tính lại.");
  },
  "settle-export": (d) => {
    const s = settlement(d.inv, S.month);
    const inv = byId("investors", d.inv);
    exportCSV(`quyet-toan-${S.month}-${(inv?.name || d.inv).replace(/[^\w]+/g, "-")}.csv`, [
      [`Quyết toán ${mvn(S.month)} – ${inv?.name}`, s.locked ? "Đã khóa sổ" : "Nháp"],
      [],
      ["Cơ sở", "Số phòng", "Đêm đã bán", "Đêm có sẵn", "Doanh thu đêm", "Điều chỉnh", "Chi phí trực tiếp", "Chi phí chung phân bổ", "Lợi nhuận"],
      ...s.lines.map((l) => [propName(l.propertyId), l.roomCount, l.soldNights, l.availableNights, l.nightRevenue, l.adjustments, l.directCost, l.commonCostAlloc, l.profit]),
      [],
      ["Lợi nhuận tổng", s.totalProfit],
      [`Phí quản lý ${config().managementFeePct}%`, s.managementFee],
      ["NĐT nhận", s.investorNet],
    ]);
  },

  // ----- Công việc -----
  "task-open": (d) => openModal("task", { id: d.id, live: true }),
  "task-new": () => openModal("taskForm", {}),
  "task-edit": (d) => openModal("taskForm", { id: d.id }),
  "task-save": async (d) => {
    const prev = d.id ? byId("tasks", d.id) : null;
    const title = val("tf-title").trim(), due = val("tf-due");
    if (!title) return err("tf-err", "Nhập tên việc.");
    if (!due) return err("tf-err", "Chọn hạn chót.");
    const type = val("tf-type");
    const doc = {
      ...(prev || { status: "TODO", photoIds: [], completedAt: null, bookingId: null }),
      id: prev?.id || uid("t"), title, type, priority: val("tf-pri"), propertyId: val("tf-prop"), roomId: val("tf-room") || null,
      assigneeId: val("tf-who"), assignedById: prev?.assignedById || me().id, dueAt: due, description: val("tf-desc"),
      recurrenceRule: val("tf-rec") || null,
      checklist: prev?.checklist || (type === "CLEANING" ? config().checklist.map((item) => ({ item, done: false })) : null),
    };
    await save("tasks", doc);
    closeModal();
    toast(prev ? "Đã cập nhật việc" : `Đã giao việc cho ${staffName(doc.assigneeId)}`);
  },
  "task-check": async (d, t) => {
    const task = byId("tasks", d.id);
    const checklist = task.checklist.map((c, i) => (i === Number(d.i) ? { ...c, done: t.checked } : c));
    await save("tasks", { ...task, checklist, status: task.status === "TODO" ? "IN_PROGRESS" : task.status });
  },
  "task-status": async (d) => {
    const task = byId("tasks", d.id);
    const s = d.s;
    if (s === "DONE") {
      const note = $("task-note")?.value?.trim();
      if (task.checklist && task.checklist.some((c) => !c.done)) return err("task-err", "Tick đủ các mục checklist trước khi hoàn thành.");
      const hasProof = (task.photoIds || []).length || note || task.proofNote;
      if (["CLEANING", "MAINTENANCE"].includes(task.type) && !hasProof) return err("task-err", S.assets ? "Chụp ít nhất một ảnh nghiệm thu trước khi hoàn thành." : "Nhập ghi chú nghiệm thu trước khi hoàn thành.");
      await save("tasks", { ...task, status: "DONE", completedAt: nowVN(), proofNote: note || task.proofNote || "" });
      // Việc định kỳ: sinh lần kế tiếp
      if (task.recurrenceRule?.startsWith("monthly:")) {
        const day = String(Number(task.recurrenceRule.split(":")[1])).padStart(2, "0");
        const nm = D.nextMonth(task.dueAt.slice(0, 7));
        const dd = Number(day) > D.daysInMonth(nm) ? D.lastDay(nm) : `${nm}-${day}`;
        await save("tasks", { ...task, id: uid("t"), status: "TODO", completedAt: null, photoIds: [], proofNote: "", dueAt: `${dd}${task.dueAt.slice(10)}` });
      }
      toast("Đã hoàn thành");
    } else {
      await save("tasks", { ...task, status: s, completedAt: s === "DONE" ? nowVN() : null });
      toast(s === "CANCELLED" ? "Đã hủy việc" : "Đã cập nhật");
    }
    renderModal();
  },
  "task-gen-cleaning": async () => {
    const pids = visiblePropertyIds();
    const days = [S.today, D.addDays(S.today, 1)];
    const cfg = config();
    let n = 0;
    for (const b of allBookings().filter((b) => b.status === "CONFIRMED" && pids.includes(b.propertyId) && days.includes(b.checkOut))) {
      if (S.data.tasks.some((t) => t.bookingId === b.id && t.type === "CLEANING")) continue;
      const nextIn = allBookings().filter((x) => x.roomId === b.roomId && x.status === "CONFIRMED" && x.checkIn >= b.checkOut).sort((a, c) => a.checkIn.localeCompare(c.checkIn))[0];
      const hk = S.data.staff.find((s) => s.role === "HOUSEKEEPER" && s.active !== false && (s.propertyIds || []).includes(b.propertyId));
      const room = allRooms().find((r) => r.id === b.roomId);
      await save("tasks", {
        id: uid("t"), type: "CLEANING", title: `Dọn ${room?.name || "phòng"} sau check-out – ${b.guestName || "khách"}`, propertyId: b.propertyId, roomId: b.roomId,
        bookingId: b.id, assigneeId: hk?.id || me().id, assignedById: me().id, dueAt: `${nextIn?.checkIn === b.checkOut ? b.checkOut : b.checkOut}T14:00`,
        priority: nextIn?.checkIn === b.checkOut ? "HIGH" : "MEDIUM", status: "TODO", description: nextIn?.checkIn === b.checkOut ? `Có khách mới nhận phòng cùng ngày (${nextIn.guestName}).` : "",
        completedAt: null, photoIds: [], checklist: (cfg.checklist || []).map((item) => ({ item, done: false })),
      });
      n++;
    }
    toast(n ? `Đã tạo ${n} việc dọn phòng cho hôm nay và ngày mai` : "Không có phòng check-out mới cần tạo việc");
  },

  // ----- Chấm công -----
  "clock-in": async () => {
    const u = me();
    const month = currentMonth();
    const id = `${month}__${u.id}`;
    const doc = byId("attendance", id) || { id, month, userId: u.id, rows: [] };
    if (doc.rows.some((r) => r.date === S.today)) return toast("Hôm nay đã vào ca rồi.");
    await save("attendance", { ...doc, rows: [...doc.rows, { id: `${u.id}-${S.today}`, userId: u.id, propertyId: val("att-prop"), date: S.today, checkInAt: nowVN(), checkOutAt: null }] });
    toast(`Đã vào ca lúc ${nowVN().slice(11, 16)}`);
  },
  "clock-out": async () => {
    const u = me();
    const month = currentMonth();
    const id = `${month}__${u.id}`;
    let doc = byId("attendance", id);
    if (!doc) {
      // Dữ liệu mẫu gom cả tháng trong một tài liệu: chuyển dòng hôm nay sang tài liệu riêng của người dùng
      const shared = S.data.attendance.find((a) => (a.rows || []).some((r) => r.userId === u.id && r.date === S.today));
      if (!shared) return toast("Chưa vào ca hôm nay.");
      const row = shared.rows.find((r) => r.userId === u.id && r.date === S.today);
      await save("attendance", { ...shared, rows: shared.rows.filter((r) => r !== row) });
      doc = { id, month, userId: u.id, rows: [row] };
    }
    await save("attendance", { ...doc, rows: doc.rows.map((r) => (r.date === S.today ? { ...r, checkOutAt: nowVN() } : r)) });
    toast(`Đã ra ca lúc ${nowVN().slice(11, 16)}`);
  },
  "export-attendance": () => {
    const rows = attendanceRows(S.month).sort((a, b) => (a.userId + a.date).localeCompare(b.userId + b.date));
    exportCSV(`cham-cong-${S.month}.csv`, [["Nhân viên", "Ngày", "Cơ sở", "Vào ca", "Ra ca"], ...rows.map((r) => [staffName(r.userId), r.date, propName(r.propertyId), r.checkInAt.slice(11, 16), r.checkOutAt ? r.checkOutAt.slice(11, 16) : ""])]);
  },

  // ----- Dayladau -----
  "dld-open": async (d) => { S.ui = { adTab: "dayladau" }; DLD.invId = d.id; DLD.orders.clear(); DLD.result = null; await loadToken(d.id); render(); },
  "dld-inv": async (d) => { DLD.invId = d.id; DLD.orders.clear(); DLD.result = null; DLD.error = ""; DLD.pages = 3; await loadToken(d.id); render(); },
  "dld-more": () => { DLD.pages++; render(); },
  "dld-save": async () => {
    try {
      await saveConnection(DLD.invId, val("dld-host").trim(), val("dld-token").trim());
      DLD.error = "";
      toast("Đã lưu thông tin kết nối");
    } catch (e) { DLD.error = e.message; render(); }
  },
  "dld-read": () => {
    const text = val("dld-paste");
    if (!text.trim()) { DLD.error = "Dán nội dung trang Dayladau vào ô trước."; return render(); }
    try { const r = addPasted(text); DLD.error = ""; toast(`Đọc ${r.count} đơn (${r.added} đơn mới so với lần đọc trước)`); }
    catch (e) { DLD.error = e.message; }
    render();
    const ta = $("dld-paste"); if (ta && !DLD.error) ta.value = "";
  },
  "dld-clear": () => { DLD.orders.clear(); DLD.result = null; render(); },
  "dld-import": async (d, t) => {
    t.disabled = true; t.textContent = "Đang nhập…";
    const r = await runImport(DLD.invId);
    DLD.result = `Đã nhập: ${r.created} đơn mới, ${r.updated} đơn cập nhật${r.adjustments ? `, ${r.adjustments} khoản điều chỉnh cho tháng đã khóa` : ""}${r.skipped ? `. ${r.skipped} đơn bỏ qua vì listing chưa gắn phòng` : ""}.`;
    render();
  },

  // ----- Quản trị -----
  "prop-edit": (d) => openModal("propForm", { id: d.id || null }),
  "pf-room-add": () => {
    syncRoomInputs();
    const p = S.modal.id ? byId("properties", S.modal.id) : null;
    S.modal.rooms.push({ id: uid(`${p?.id || "p"}-r`), name: `P${S.modal.rooms.length + 1}01`, openedOn: S.today, closedOn: null, dayladauRoomId: "" });
    renderModal();
  },
  "prop-save": async (d) => {
    syncRoomInputs();
    const prev = d.id ? byId("properties", d.id) : null;
    const name = val("pf-name").trim();
    if (!name) return err("pf-err", "Nhập tên cơ sở.");
    if (!val("pf-inv")) return err("pf-err", "Tạo nhà đầu tư trước.");
    await save("properties", {
      ...(prev || { active: true }), id: prev?.id || uid("p"), name, investorId: val("pf-inv"), address: val("pf-addr"),
      investmentAmount: parseMoney(val("pf-invest")), investmentStartMonth: val("pf-start"), fixedCostMonthly: parseMoney(val("pf-fixed")),
      variableCostPerNight: parseMoney(val("pf-var")), occupancyKpiPct: Number(val("pf-kpi")) || 70, rooms: S.modal.rooms,
    });
    closeModal(); toast("Đã lưu cơ sở");
  },
  "inv-edit": (d) => openModal("invForm", { id: d.id || null }),
  "inv-save": async (d) => {
    const prev = d.id ? byId("investors", d.id) : null;
    const name = val("if-name").trim();
    if (!name) return err("if-err", "Nhập tên nhà đầu tư.");
    await save("investors", { ...(prev || {}), id: prev?.id || uid("inv"), name });
    closeModal(); toast("Đã lưu nhà đầu tư");
  },
  "staff-edit": (d) => openModal("staffForm", { id: d.id || null }),
  "staff-save": async (d) => {
    const prev = d.id ? byId("staff", d.id) : null;
    const name = val("sf-name").trim();
    const r = val("sf-role");
    if (!name) return err("sf-err", "Nhập tên.");
    const propertyIds = [...document.querySelectorAll('[id^="sf-p-"]:checked')].map((x) => x.value);
    await save("staff", { ...(prev || {}), id: prev?.id || uid("u"), name, role: r, investorId: r === "INVESTOR" ? val("sf-inv") : null, propertyIds, active: val("sf-active") === "1" });
    closeModal(); toast("Đã lưu người dùng");
  },
  "settings-save": async () => {
    const c = config();
    const commission = { ...(c.commission || {}) };
    document.querySelectorAll('[id^="set-com-"]').forEach((el) => (commission[el.dataset.ch] = Number(el.value) || 0));
    const fee = Number(val("set-fee"));
    if (!(fee >= 0 && fee <= 100)) return toast("Phí quản lý phải từ 0 đến 100%.");
    await save("config", {
      ...c, id: "app", managementFeePct: fee, commission, syncTime: val("set-sync") || "06:00", larkWebhook: val("set-lark"),
      checklist: val("set-checklist").split("\n").map((s) => s.trim()).filter(Boolean),
    });
    toast("Đã lưu cài đặt");
  },
};

function syncRoomInputs() {
  S.modal.rooms = S.modal.rooms.map((r, i) => ({
    ...r, name: val(`pr-name-${i}`) || r.name, openedOn: val(`pr-open-${i}`) || r.openedOn, closedOn: val(`pr-close-${i}`) || null, dayladauRoomId: val(`pr-dld-${i}`),
  }));
}

boot();

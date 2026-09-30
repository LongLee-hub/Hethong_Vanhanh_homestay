// @ts-nocheck
import {
  D, S, esc, vnd, dvn, mvn, can, role, me, byId, config, feePct, allRooms, allBookings, nights, propName,
  staffName, visibleProperties, visiblePropertyIds, allowedPropertyIds, currentMonth, nowVN, ROLE_LABEL,
  TASK_TYPE, TASK_STATUS, PRIORITY, signCls,
} from "./core";
import { stat, pill, empty, chColor, short } from "./views";
import { viewDayladau } from "./dayladau";

// ================= CÔNG VIỆC =================
export function visibleTasks() {
  const pids = visiblePropertyIds();
  let list = S.data.tasks.filter((t) => pids.includes(t.propertyId));
  if (role() === "HOUSEKEEPER") list = list.filter((t) => t.assigneeId === me().id);
  return list;
}

export function viewTasks() {
  const mode = S.ui.tkMode || (role() === "HOUSEKEEPER" ? "today" : "board");
  const who = S.ui.tkWho || "";
  const type = S.ui.tkType || "";
  const now = nowVN();
  let list = visibleTasks().filter((t) => (!who || t.assigneeId === who) && (!type || t.type === type));
  if (mode === "today") list = list.filter((t) => t.dueAt.slice(0, 10) <= S.today && t.status !== "CANCELLED" && (t.status !== "DONE" || (t.completedAt || "").slice(0, 10) === S.today));
  const assignees = S.data.staff.filter((s) => s.role !== "INVESTOR" && s.active !== false);

  const card = (t) => {
    const overdue = ["TODO", "IN_PROGRESS"].includes(t.status) && t.dueAt < now;
    const room = t.roomId ? allRooms().find((r) => r.id === t.roomId)?.name : "";
    const cl = t.checklist ? `${t.checklist.filter((c) => c.done).length}/${t.checklist.length}` : "";
    return `<button class="task ${overdue ? "overdue" : ""}" data-act="task-open" data-id="${t.id}">
      <span class="row small"><span class="pill">${TASK_TYPE[t.type]}</span>${t.priority === "HIGH" || t.priority === "URGENT" ? pill(PRIORITY[t.priority], "bad") : ""}${overdue ? pill("Quá hạn", "bad") : ""}</span>
      <span class="t">${esc(t.title)}</span>
      <span class="small muted">${esc(propName(t.propertyId))}${room ? " · " + esc(room) : ""} · hạn ${dvn(t.dueAt)} ${t.dueAt.slice(11, 16)}</span>
      <span class="small muted">${esc(staffName(t.assigneeId))}${cl ? ` · checklist ${cl}` : ""}${(t.photoIds || []).length ? ` · ${t.photoIds.length} ảnh` : ""}</span>
    </button>`;
  };

  const head = `<div class="row" style="margin-bottom:14px">
    <div class="seg">
      <button data-act="ui" data-k="tkMode" data-v="today" aria-pressed="${mode === "today"}">Hôm nay</button>
      <button data-act="ui" data-k="tkMode" data-v="board" aria-pressed="${mode === "board"}">Bảng</button>
      <button data-act="ui" data-k="tkMode" data-v="list" aria-pressed="${mode === "list"}">Danh sách</button>
    </div>
    ${role() !== "HOUSEKEEPER" ? `<select id="tk-who" data-on="ui" data-k="tkWho" style="max-width:190px"><option value="">Mọi người làm</option>${assignees.map((s) => `<option value="${s.id}" ${s.id === who ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>` : ""}
    <select id="tk-type" data-on="ui" data-k="tkType" style="max-width:170px"><option value="">Mọi loại việc</option>${Object.entries(TASK_TYPE).map(([k, v]) => `<option value="${k}" ${k === type ? "selected" : ""}>${v}</option>`).join("")}</select>
    <span class="spacer"></span>
    ${can("assign") ? `<button class="btn" data-act="task-gen-cleaning">Sinh việc dọn phòng</button><button class="btn primary" data-act="task-new">+ Giao việc</button>` : ""}
  </div>`;

  if (mode === "board") {
    const cols = ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"];
    return head + `<div class="kanban">${cols.map((c) => {
      const items = list.filter((t) => t.status === c).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
      const shown = c === "DONE" || c === "CANCELLED" ? items.slice(-12).reverse() : items;
      return `<div class="col"><h3>${TASK_STATUS[c]}<span class="muted">${items.length}</span></h3>${shown.map(card).join("") || `<div class="small muted">Trống</div>`}</div>`;
    }).join("")}</div>`;
  }
  if (mode === "today") {
    const open = list.filter((t) => t.status !== "DONE").sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    const done = list.filter((t) => t.status === "DONE");
    return head + `<div class="grid g2"><section class="panel"><header><h2>Cần làm (${open.length})</h2></header><div class="stack" style="gap:8px">${open.map(card).join("") || empty("Không còn việc nào hôm nay.")}</div></section>
      <section class="panel"><header><h2>Đã xong hôm nay (${done.length})</h2></header><div class="stack" style="gap:8px">${done.map(card).join("") || `<div class="small muted">Chưa có.</div>`}</div></section></div>`;
  }
  const sorted = [...list].sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  return head + `<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Việc</th><th>Loại</th><th>Cơ sở</th><th>Người làm</th><th>Hạn</th><th>Trạng thái</th></tr></thead><tbody>
    ${sorted.map((t) => `<tr class="click" data-act="task-open" data-id="${t.id}"><td><b>${esc(t.title)}</b></td><td>${TASK_TYPE[t.type]}</td><td>${esc(propName(t.propertyId))}</td><td>${esc(staffName(t.assigneeId))}</td><td class="num">${dvn(t.dueAt)} ${t.dueAt.slice(11, 16)}</td><td>${statusPill(t)}</td></tr>`).join("") || `<tr><td colspan="6">${empty("Chưa có việc nào.")}</td></tr>`}
  </tbody></table></div></div>`;
}

export function statusPill(t) {
  const overdue = ["TODO", "IN_PROGRESS"].includes(t.status) && t.dueAt < nowVN();
  if (overdue) return pill("Quá hạn", "bad");
  return pill(TASK_STATUS[t.status], t.status === "DONE" ? "ok" : t.status === "IN_PROGRESS" ? "fc" : "");
}

// ================= CHẤM CÔNG =================
export function attendanceRows(month) {
  return S.data.attendance.filter((a) => (a.month || a.id.slice(0, 7)) === month).flatMap((a) => a.rows || []);
}

export function viewAttendance() {
  const u = me();
  const month = S.month;
  const rows = attendanceRows(month);
  const todayRow = attendanceRows(currentMonth()).find((r) => r.userId === u.id && r.date === S.today);
  const myProps = S.data.properties.filter((p) => allowedPropertyIds().includes(p.id));
  const clock = u.role !== "INVESTOR" ? `<section class="panel"><header><div><h2>${esc(u.name)}</h2><p>${dvn(S.today)}</p></div>
      ${todayRow ? (todayRow.checkOutAt ? pill("Đã ra ca", "ok") : pill("Đang trong ca", "fc")) : pill("Chưa vào ca")}</header>
      ${todayRow ? `<p class="small">Vào ca ${todayRow.checkInAt.slice(11, 16)} tại ${esc(propName(todayRow.propertyId))}${todayRow.checkOutAt ? ` · Ra ca ${todayRow.checkOutAt.slice(11, 16)}` : ""}</p>` : ""}
      <div class="field" style="margin-bottom:12px"><span>Cơ sở làm việc</span><select id="att-prop">${myProps.map((p) => `<option value="${p.id}" ${todayRow?.propertyId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
      <div class="clock-btns">
        <button class="btn primary" data-act="clock-in" ${todayRow ? "disabled" : ""}>Vào ca</button>
        <button class="btn" data-act="clock-out" ${!todayRow || todayRow.checkOutAt ? "disabled" : ""}>Ra ca</button>
      </div></section>` : "";

  if (!can("attendanceAll")) {
    const mine = rows.filter((r) => r.userId === u.id).sort((a, b) => b.date.localeCompare(a.date));
    return `<div class="grid g2">${clock}<section class="panel"><header><h2>Ngày công ${mvn(month).toLowerCase()}: ${mine.length}</h2></header>
      <div class="tbl-wrap"><table><thead><tr><th>Ngày</th><th>Cơ sở</th><th>Vào</th><th>Ra</th></tr></thead><tbody>${mine.map((r) => `<tr><td class="num">${dvn(r.date)}</td><td>${esc(propName(r.propertyId))}</td><td class="num">${r.checkInAt.slice(11, 16)}</td><td class="num">${r.checkOutAt ? r.checkOutAt.slice(11, 16) : "—"}</td></tr>`).join("") || `<tr><td colspan="4" class="muted small">Chưa có ngày công.</td></tr>`}</tbody></table></div></section></div>`;
  }

  const days = D.eachDay(D.firstDay(month), D.lastDay(month));
  const pids = visiblePropertyIds();
  const staff = S.data.staff.filter((s) => ["MANAGER", "HOUSEKEEPER", "ACCOUNTANT"].includes(s.role) && s.active !== false && ((s.propertyIds || []).some((p) => pids.includes(p))));
  const grid = `<div class="tbl-wrap"><table style="font-size:.78rem"><thead><tr><th>Nhân viên</th>${days.map((d) => `<th class="n" style="padding:6px 3px">${Number(d.slice(8))}</th>`).join("")}<th class="n">Công</th></tr></thead><tbody>
    ${staff.map((s) => {
      const mine = rows.filter((r) => r.userId === s.id);
      return `<tr><td style="white-space:nowrap">${esc(s.name)}</td>${days.map((d) => {
        const r = mine.find((x) => x.date === d);
        return `<td class="n" style="padding:6px 3px" title="${r ? `${r.checkInAt.slice(11, 16)}–${r.checkOutAt ? r.checkOutAt.slice(11, 16) : "?"}` : ""}">${r ? `<span class="dot" style="background:${r.checkOutAt ? "var(--accent)" : "var(--gold)"};margin:0"></span>` : ""}</td>`;
      }).join("")}<td class="n"><b>${mine.length}</b></td></tr>`;
    }).join("")}</tbody></table></div>`;
  return `<div class="stack">${clock ? `<div class="grid g2">${clock}<div></div></div>` : ""}
    <section class="panel"><header><div><h2>Bảng chấm công ${mvn(month).toLowerCase()}</h2><p><span class="dot" style="background:var(--accent)"></span>Đủ vào/ra &nbsp; <span class="dot" style="background:var(--gold)"></span>Chưa ra ca</p></div>
    <button class="btn sm" data-act="export-attendance">Xuất CSV</button></header>${grid}</section></div>`;
}

// ================= BÁO CÁO =================
export function viewReports() {
  const month = S.month;
  const pm = D.prevMonth(month);
  const pids = visiblePropertyIds();
  const props = visibleProperties();
  const showMoney = can("finance");

  // So sánh tháng
  const cmp = props.map((p) => {
    const rooms = allRooms().filter((r) => r.propertyId === p.id);
    const pn = nights().filter((n) => n.propertyId === p.id);
    const a = D.computeKpis(pn, rooms, D.firstDay(month), D.lastDay(month));
    const b = D.computeKpis(pn, rooms, D.firstDay(pm), D.lastDay(pm));
    const reviews = []; // Điểm đánh giá: nhập tay / import Apify ở bản chính thức
    return { p, a, b };
  });
  const delta = (x, y) => (y ? Math.round(((x - y) / y) * 1000) / 10 : null);
  const dCell = (d) => (d === null ? `<span class="muted">—</span>` : `<span class="${d < 0 ? "neg" : "pos"}">${d > 0 ? "+" : ""}${d}%</span>`);

  // Công suất đã đặt cho 30/60/90 ngày tới
  const fwd = props.map((p) => {
    const rooms = allRooms().filter((r) => r.propertyId === p.id);
    const pn = nights().filter((n) => n.propertyId === p.id);
    return { p, v: [30, 60, 90].map((n) => D.computeKpis(pn, rooms, S.today, D.addDays(S.today, n - 1)).occupancyPct) };
  });

  // Lead time theo kênh (đơn có check-in trong tháng)
  const from = D.firstDay(month), to = D.lastDay(month);
  const bks = allBookings().filter((b) => pids.includes(b.propertyId) && b.checkIn >= from && b.checkIn <= to && b.status === "CONFIRMED");
  const chans = ["Airbnb", "Booking", "Agoda", "Trực tiếp"];
  const lt = chans.map((c) => ({ c, d: D.leadTimeDistribution(bks.filter((b) => b.channel === c)) }));
  const ltAll = D.leadTimeDistribution(bks);
  const ltTotal = Object.values(ltAll).reduce((s, n) => s + n, 0);

  // Chi phí theo loại
  const exps = S.data.expenses.filter((e) => e.month === month && e.propertyId && pids.includes(e.propertyId));
  const byCat = {};
  for (const e of exps) byCat[e.categoryId] = (byCat[e.categoryId] || 0) + e.amount;
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...catRows.map((x) => x[1]));

  // Nhân sự
  const staff = S.data.staff.filter((s) => ["MANAGER", "HOUSEKEEPER"].includes(s.role) && s.active !== false);
  const att = S.data.attendance.filter((a) => (a.month || a.id.slice(0, 7)) === month).flatMap((a) => a.rows || []);
  const hr = staff.map((s) => {
    const done = S.data.tasks.filter((t) => t.assigneeId === s.id && t.status === "DONE" && (t.completedAt || "").slice(0, 7) === month);
    const onTime = done.filter((t) => t.completedAt <= t.dueAt).length;
    return { s, done: done.length, onTime, days: att.filter((r) => r.userId === s.id).length };
  });

  return `<div class="stack">
    <section class="panel"><header><div><h2>${mvn(month)} so với ${mvn(pm).toLowerCase()}</h2><p>Doanh thu net theo đêm; đánh giá khách sẽ lấy từ nguồn nhập tay hoặc Apify ở bản chính thức</p></div></header>
      <div class="tbl-wrap"><table><thead><tr><th>Cơ sở</th><th class="n">Công suất</th><th class="n">±</th><th class="n">ADR</th><th class="n">±</th>${showMoney ? `<th class="n">Doanh thu</th><th class="n">±</th><th class="n">RevPAR</th>` : ""}</tr></thead><tbody>
      ${cmp.map(({ p, a, b }) => `<tr><td>${esc(p.name)}</td><td class="n">${a.occupancyPct}%</td><td class="n">${dCell(b.occupancyPct ? Math.round((a.occupancyPct - b.occupancyPct) * 10) / 10 : null)}</td><td class="n">${vnd(a.adr)}</td><td class="n">${dCell(delta(a.adr, b.adr))}</td>${showMoney ? `<td class="n">${vnd(a.revenue)}</td><td class="n">${dCell(delta(a.revenue, b.revenue))}</td><td class="n">${vnd(a.revpar)}</td>` : ""}</tr>`).join("")}
      </tbody></table></div><p class="small muted">Cột ± của công suất là chênh lệch điểm phần trăm; các cột ± khác là % thay đổi.</p></section>

    <div class="grid g2">
      <section class="panel"><header><div><h2>Công suất đã đặt phía trước</h2><p>Tính từ hôm nay, dùng để quyết định tăng hay giảm giá</p></div></header>
        <div class="tbl-wrap"><table><thead><tr><th>Cơ sở</th><th class="n">30 ngày</th><th class="n">60 ngày</th><th class="n">90 ngày</th></tr></thead><tbody>
        ${fwd.map(({ p, v }) => `<tr><td>${esc(p.name)}</td>${v.map((x) => `<td class="n ${x < (p.occupancyKpiPct ?? 70) ? "" : "pos"}">${x}%</td>`).join("")}</tr>`).join("")}
        </tbody></table></div></section>

      <section class="panel"><header><div><h2>Khách đặt trước bao lâu</h2><p>${ltTotal} đơn check-in trong ${mvn(month).toLowerCase()}, số ngày từ lúc đặt đến ngày nhận phòng</p></div></header>
        <div class="tbl-wrap"><table><thead><tr><th>Kênh</th>${D.LEAD_TIME_BUCKETS.map((b) => `<th class="n">${b} ngày</th>`).join("")}</tr></thead><tbody>
        ${lt.map(({ c, d }) => `<tr><td><span class="dot" style="background:${chColor(c)}"></span>${c}</td>${D.LEAD_TIME_BUCKETS.map((b) => `<td class="n">${d[b] || ""}</td>`).join("")}</tr>`).join("")}
        <tr class="total"><td>Tất cả</td>${D.LEAD_TIME_BUCKETS.map((b) => `<td class="n">${ltTotal ? Math.round((ltAll[b] / ltTotal) * 100) : 0}%</td>`).join("")}</tr>
        </tbody></table></div></section>

      ${showMoney ? `<section class="panel"><header><h2>Chi phí trực tiếp theo loại</h2></header><div class="stack" style="gap:8px">
        ${catRows.map(([id, v]) => `<div class="hbar"><span>${esc(byId("categories", id)?.name || id)}</span><div class="track"><div class="fill" style="width:${(v / catMax) * 100}%"></div></div><span class="num small">${short(v)}</span></div>`).join("") || `<div class="small muted">Chưa có chi phí.</div>`}
      </div></section>` : ""}

      ${role() !== "INVESTOR" ? `<section class="panel"><header><div><h2>Nhân sự ${mvn(month).toLowerCase()}</h2><p>KPI tính theo số việc hoàn thành; tỷ lệ đúng hạn để tham khảo</p></div></header>
        <div class="tbl-wrap"><table><thead><tr><th>Nhân viên</th><th class="n">Việc xong</th><th class="n">Đúng hạn</th><th class="n">Ngày công</th></tr></thead><tbody>
        ${hr.map((x) => `<tr><td>${esc(x.s.name)}</td><td class="n"><b>${x.done}</b></td><td class="n">${x.done ? Math.round((x.onTime / x.done) * 100) + "%" : "—"}</td><td class="n">${x.days}</td></tr>`).join("")}
        </tbody></table></div></section>` : ""}
    </div></div>`;
}

// ================= QUẢN TRỊ =================
export function viewAdmin() {
  const tab = S.ui.adTab || "props";
  const tabs = [["props", "Cơ sở & phòng"], ["investors", "Nhà đầu tư"], ["dayladau", "Đồng bộ Dayladau"], ["staff", "Người dùng"], ["settings", "Cài đặt"], ["data", "Dữ liệu"]];
  const head = `<div class="row" style="margin-bottom:14px"><div class="seg">${tabs.map(([k, v]) => `<button data-act="ui" data-k="adTab" data-v="${k}" aria-pressed="${tab === k}">${v}</button>`).join("")}</div></div>`;
  let body = "";
  if (tab === "dayladau") {
    body = viewDayladau();
  } else if (tab === "props") {
    body = `<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" data-act="prop-edit" data-id="">+ Thêm cơ sở</button></div>
      <div class="grid g2">${S.data.properties.sort((a, b) => a.name.localeCompare(b.name, "vi")).map((p) => `<section class="panel"><header><div><h2>${esc(p.name)}</h2><p>${esc(byId("investors", p.investorId)?.name || "Chưa gán NĐT")}</p></div><button class="btn sm" data-act="prop-edit" data-id="${p.id}">Sửa</button></header>
        <div class="small stack" style="gap:4px">
          <div class="row"><span class="muted">Vốn đầu tư</span><span class="spacer"></span><span class="num">${vnd(p.investmentAmount)}</span></div>
          <div class="row"><span class="muted">Bắt đầu tính hoàn vốn</span><span class="spacer"></span><span>${p.investmentStartMonth ? mvn(p.investmentStartMonth) : "—"}</span></div>
          <div class="row"><span class="muted">Chi phí cố định dự kiến / tháng</span><span class="spacer"></span><span class="num">${vnd(p.fixedCostMonthly)}</span></div>
          <div class="row"><span class="muted">Chi phí biến đổi / đêm</span><span class="spacer"></span><span class="num">${vnd(p.variableCostPerNight)}</span></div>
          <div class="row"><span class="muted">Ngưỡng cảnh báo công suất</span><span class="spacer"></span><span>${p.occupancyKpiPct ?? 70}%</span></div>
          <div class="row" style="margin-top:6px"><span class="lbl">Phòng (${(p.rooms || []).filter((r) => !r.closedOn).length} đang hoạt động)</span></div>
          <div class="chips">${(p.rooms || []).map((r) => `<span class="pill ${r.closedOn ? "" : "ok"}">${esc(r.name)}${r.closedOn ? " · đóng" : ""}${r.dayladauRoomId ? "" : " · chưa map"}</span>`).join("")}</div>
        </div></section>`).join("")}</div>`;
  } else if (tab === "investors") {
    body = `<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" data-act="inv-edit" data-id="">+ Thêm nhà đầu tư</button></div>
      <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Nhà đầu tư</th><th>Cơ sở</th><th>Dayladau host ID</th><th>Token</th><th></th></tr></thead><tbody>
      ${S.data.investors.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td>${S.data.properties.filter((p) => p.investorId === i.id).map((p) => esc(p.name)).join(", ") || "—"}</td><td>${esc(i.dayladauHostId || "—")}</td><td>${i.hasToken ? pill("Đã lưu " + (i.tokenHint || ""), "ok") : pill("Chưa có", "warn")}</td><td class="row"><button class="btn sm" data-act="inv-edit" data-id="${i.id}">Sửa tên</button><button class="btn sm primary" data-act="dld-open" data-id="${i.id}">Kết nối Dayladau</button></td></tr>`).join("")}
      </tbody></table></div><p class="small muted">Mỗi nhà đầu tư có host ID và access token riêng. Bấm "Kết nối Dayladau" để nhập và lấy đơn.</p></div>`;
  } else if (tab === "staff") {
    body = `<div class="row" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" data-act="staff-edit" data-id="">+ Thêm người dùng</button></div>
      <div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Tên</th><th>Vai trò</th><th>Cơ sở được truy cập</th><th>Trạng thái</th><th></th></tr></thead><tbody>
      ${S.data.staff.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${ROLE_LABEL[s.role]}</td><td class="small">${s.role === "ADMIN" ? "Tất cả" : s.role === "INVESTOR" ? `Cơ sở của ${esc(byId("investors", s.investorId)?.name || "?")}` : (s.propertyIds || []).map(propName).join(", ") || "—"}</td><td>${s.active === false ? pill("Ngừng") : pill("Hoạt động", "ok")}</td><td><button class="btn sm" data-act="staff-edit" data-id="${s.id}">Sửa</button></td></tr>`).join("")}
      </tbody></table></div></div>`;
  } else if (tab === "settings") {
    const c = config();
    body = `<div class="grid g2"><section class="panel"><header><h2>Tài chính</h2></header><div class="form-grid">
        <label class="field"><span>Phí quản lý (% lợi nhuận)</span><input type="number" id="set-fee" min="0" max="100" value="${esc(c.managementFeePct)}"></label>
        <label class="field"><span>Giờ đồng bộ Dayladau hằng ngày</span><input type="text" id="set-sync" value="${esc(c.syncTime || "06:00")}"></label>
        ${["Airbnb", "Booking", "Agoda", "Trực tiếp"].map((ch, i) => `<label class="field"><span>Hoa hồng ${ch} (%)</span><input type="number" id="set-com-${i}" data-ch="${ch}" min="0" max="100" step="0.1" value="${esc(c.commission?.[ch] ?? 0)}"></label>`).join("")}
        <label class="field full"><span>Lark webhook nhận cảnh báo</span><input type="text" id="set-lark" value="${esc(c.larkWebhook || "")}" placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/..."></label>
      </div><div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" data-act="settings-save">Lưu cài đặt</button></div></section>
      <section class="panel"><header><div><h2>Checklist dọn phòng</h2><p>Mỗi dòng là một mục</p></div></header>
        <textarea id="set-checklist" style="min-height:200px">${esc((c.checklist || []).join("\n"))}</textarea>
        <div class="row" style="margin-top:12px"><span class="spacer"></span><button class="btn primary" data-act="settings-save">Lưu cài đặt</button></div></section></div>`;
  } else {
    const n = S.data.properties.filter((p) => p.sample).length;
    body = `<div class="grid g2"><section class="panel"><header><h2>Dữ liệu mẫu</h2></header>
      <p class="small">Bản ghi có đánh dấu mẫu: NĐT A, B; đơn, chi phí, công việc và chấm công giả lập cho ${n} cơ sở. Tên cơ sở là cơ sở thật của LOCI, số phòng và số tiền là số giả lập.</p>
      <div class="row">${S.ui.confirmClear ? `<span class="small">Xóa toàn bộ dữ liệu mẫu? Không hoàn tác được.</span><button class="btn danger" data-act="sample-clear">Xóa</button><button class="btn" data-act="ui" data-k="confirmClear" data-v="">Hủy</button>` : `<button class="btn danger" data-act="ui" data-k="confirmClear" data-v="1" ${n ? "" : "disabled"}>Xóa dữ liệu mẫu…</button><button class="btn" data-act="sample-load" ${n ? "disabled" : ""}>Nạp dữ liệu mẫu</button>`}</div></section>
      <section class="panel"><header><h2>Đồng bộ Dayladau</h2></header><p class="small">Nhập host ID, access token và lấy đơn ở tab <b>Đồng bộ Dayladau</b>.</p><button class="btn" data-act="ui" data-k="adTab" data-v="dayladau">Mở tab Đồng bộ Dayladau</button></section></div>`;
  }
  return head + body;
}

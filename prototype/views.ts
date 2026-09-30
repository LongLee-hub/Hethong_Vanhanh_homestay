// @ts-nocheck
// Các màn hình chính. Mỗi hàm trả về chuỗi HTML; sự kiện xử lý qua data-act trong main.ts.
import {
  D, S, esc, vnd, dvn, mvn, can, role, me, byId, config, feePct, allRooms, allBookings, nights, propName, invName,
  staffName, visibleProperties, visiblePropertyIds, visibleInvestors, allowedPropertyIds, isCommonFinalized, isLocked,
  settlement, investorMonthView, paybackFor, alerts, currentMonth, signCls, nowVN, ROLE_LABEL, TASK_TYPE, TASK_STATUS,
  PRIORITY, isAnyLocked, photoUrl,
} from "./core";

const I = {
  dashboard: '<path d="M3 13h8V3H3zm0 8h8v-6H3zm10 0h8V11h-8zm0-18v6h8V3z"/>',
  bookings: '<path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2zm-2 8h14v10H5z"/>',
  expenses: '<path d="M4 4h16v4H4zm0 6h16v10H4zm3 3v2h6v-2z"/>',
  settle: '<path d="M4 20V10h3v10zm6.5 0V4h3v16zM17 20v-7h3v7z"/>',
  tasks: '<path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/>',
  attendance: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6l5 3 1-1.6-4-2.4z"/>',
  reports: '<path d="M3 3h2v16h16v2H3zm4 12 4-5 3 3 5-7 1.6 1.2-6.4 9-3-3-3 3.8z"/>',
  admin: '<path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.9a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.9a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${I[k]}</svg>`;

export function navItems() {
  const r = role();
  const items = [
    ["dashboard", "Tổng quan", r !== "HOUSEKEEPER"],
    ["bookings", "Đặt phòng", can("bookings")],
    ["expenses", "Chi phí", can("expenses")],
    ["settle", "Quyết toán", can("settle")],
    ["tasks", "Công việc", can("tasks")],
    ["attendance", "Chấm công", can("attendance")],
    ["reports", "Báo cáo", can("reports")],
    ["admin", "Quản trị", can("admin")],
  ];
  return items.filter((x) => x[2]);
}

const TITLES = { dashboard: "Tổng quan", bookings: "Đặt phòng", expenses: "Chi phí", settle: "Quyết toán", tasks: "Công việc", attendance: "Chấm công", reports: "Báo cáo", admin: "Quản trị" };

function whoSelect(idSuffix) {
  const staff = S.data.staff.filter((s) => s.active !== false);
  return `<select id="who-${idSuffix}" data-on="who" aria-label="Xem với vai trò">
    ${staff.map((s) => `<option value="${s.id}" ${s.id === me().id ? "selected" : ""}>${esc(s.name)} · ${ROLE_LABEL[s.role]}</option>`).join("")}
  </select>`;
}

export function layout(content) {
  const items = navItems();
  const nav = (cls) => items.map(([k, label]) => `<button class="nav-btn ${cls}" data-act="nav" data-r="${k}" ${S.route === k ? 'aria-current="page"' : ""}>${icon(k)}<span>${label}</span></button>`).join("");
  const showMonth = !["admin", "attendance"].includes(S.route) || S.route === "attendance";
  const allowed = allowedPropertyIds();
  const props = S.data.properties.filter((p) => allowed.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name, "vi"));
  const chips = props.length > 1 && S.route !== "admin"
    ? `<div class="chips" role="group" aria-label="Lọc cơ sở">
        <button class="chip" data-act="prop" data-id="all" aria-pressed="${S.prop === "all" || !allowed.includes(S.prop)}">Tất cả cơ sở</button>
        ${props.map((p) => `<button class="chip" data-act="prop" data-id="${p.id}" aria-pressed="${S.prop === p.id}">${esc(p.name)}</button>`).join("")}
      </div>` : "";
  const banner = S.mode === "demo"
    ? `<div class="banner">Đang chạy ở chế độ xem thử: dữ liệu chỉ nằm trên trình duyệt này và mất khi tải lại trang.</div>` : "";
  return `<div class="app">
    <aside class="rail">
      <div class="brand"><b>LOCI</b><span>Homestay Manager</span></div>
      ${nav("")}
      <div class="who"><span class="lbl">Xem với vai trò</span>${whoSelect("rail")}
      <span class="hint">Bản chạy thử: đổi vai trò để xem mỗi người thấy gì. Bản chính thức dùng đăng nhập.</span></div>
    </aside>
    <main class="main">
      <div class="topbar">
        <h1>${TITLES[S.route] || ""}</h1>
        ${showMonth ? `<div class="month-step"><button data-act="month" data-d="-1" aria-label="Tháng trước">‹</button><span class="num">${mvn(S.month)}</span><button data-act="month" data-d="1" aria-label="Tháng sau">›</button></div>` : ""}
        ${S.month !== currentMonth() && showMonth ? `<button class="btn sm" data-act="month-now">Tháng này</button>` : ""}
        ${chips}
        <div class="mobile-who"><span class="lbl">Vai trò</span>${whoSelect("mob")}</div>
      </div>
      ${banner}
      ${content}
    </main>
    <nav class="bottom-nav">${nav("")}</nav>
  </div>`;
}

// ---------- Khối dùng chung ----------
const stat = (label, value, sub = "", cls = "") => `<div class="stat ${cls}"><span class="lbl">${label}</span><span class="v ${cls.includes("sign") ? "" : ""}">${value}</span>${sub ? `<span class="s">${sub}</span>` : ""}</div>`;
const pill = (text, cls = "") => `<span class="pill ${cls}">${esc(text)}</span>`;
const empty = (text, action = "") => `<div class="empty"><div>${text}</div>${action}</div>`;
const chColor = (ch) => ({ Airbnb: "var(--ch-airbnb)", Booking: "var(--ch-booking)", Agoda: "var(--ch-agoda)" }[ch] || "var(--ch-direct)");

function barChart(days, valsA, valsB, height = 160) {
  const W = 640, pad = { l: 44, r: 8, t: 8, b: 20 };
  const max = Math.max(1, ...valsA.map((v, i) => v + valsB[i]));
  const nice = niceMax(max);
  const bw = (W - pad.l - pad.r) / days.length;
  const y = (v) => pad.t + (height - pad.t - pad.b) * (1 - v / nice);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (nice / 4) * i;
    g += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/>`;
    g += `<text x="${pad.l - 6}" y="${y(v) + 3}" text-anchor="end">${short(v)}</text>`;
  }
  days.forEach((d, i) => {
    const x = pad.l + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const a = valsA[i], b = valsB[i];
    if (a) g += `<rect x="${x}" y="${y(a)}" width="${w}" height="${y(0) - y(a)}" fill="var(--accent)" rx="1.5"><title>${dvn(d)}: ${vnd(a)}</title></rect>`;
    if (b) g += `<rect x="${x}" y="${y(a + b)}" width="${w}" height="${y(a) - y(a + b)}" fill="var(--gold)" opacity=".6" rx="1.5"><title>${dvn(d)}: ${vnd(b)} (đã đặt)</title></rect>`;
    const dn = Number(d.slice(8));
    if (dn === 1 || dn % 5 === 0) g += `<text x="${x + w / 2}" y="${height - 5}" text-anchor="middle">${dn}</text>`;
  });
  return `<div class="chart"><svg viewBox="0 0 ${W} ${height}" role="img" aria-label="Doanh thu theo ngày">${g}</svg></div>`;
}
function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const k of [1, 2, 2.5, 5, 10]) if (k * p >= v) return k * p;
  return 10 * p;
}
function short(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(".0", "") + " tỷ";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(".0", "") + " tr";
  if (v >= 1e3) return Math.round(v / 1e3) + "k";
  return String(Math.round(v));
}

// ================= TỔNG QUAN =================
export function viewDashboard() {
  const month = S.month;
  const pids = visiblePropertyIds();
  if (!pids.length) return empty("Tài khoản này chưa được gán cơ sở nào. Admin gán cơ sở trong mục Quản trị.");
  const invs = visibleInvestors();
  const views = invs.map((i) => ({ inv: i, v: investorMonthView(i.id, month, pids) }));
  const tot = (f) => views.reduce((s, x) => s + f(x.v), 0);
  const cur = currentMonth();
  const isCur = month === cur, isPast = month < cur;
  const showFee = can("fee");
  const provisional = views.some((x) => x.v.provisional);

  const cards = can("finance") ? `<div class="cards">
    ${stat(isPast ? "Doanh thu tháng" : "Doanh thu thực tế", vnd(tot((v) => v.revenueActual)), isCur ? `Các đêm đến hết ${dvn(D.addDays(S.today, -1))}` : "Sau hoa hồng OTA")}
    ${isPast ? "" : stat("Doanh thu dự kiến", vnd(tot((v) => v.revenueForecast)), "Đã đặt + ước tính đêm trống", "fc")}
    ${stat("Chi phí đã nhập", vnd(tot((v) => v.costActual)), provisional ? "Gồm chi phí chung tạm tính" : "Trực tiếp + chung phân bổ")}
    ${stat(isPast ? "Lợi nhuận" : "Lợi nhuận dự kiến", `<span class="${signCls(tot((v) => v.profitForecast))}">${vnd(tot((v) => v.profitForecast))}</span>`, isPast ? "" : "Theo chi phí dự kiến", isPast ? "" : "fc")}
    ${showFee ? stat(isPast ? "Phí quản lý" : "Phí quản lý dự kiến", vnd(tot((v) => v.fee)), `${feePct()}% lợi nhuận, tính theo từng NĐT`, isPast ? "" : "fc") : ""}
    ${showFee ? stat(isPast ? "NĐT nhận" : "NĐT nhận dự kiến", `<span class="${signCls(tot((v) => v.net))}">${vnd(tot((v) => v.net))}</span>`, "", isPast ? "" : "fc") : ""}
  </div>` : "";

  // Doanh thu theo ngày
  const days = D.eachDay(D.firstDay(month), D.lastDay(month));
  const byDay = new Map(days.map((d) => [d, 0]));
  for (const n of nights()) if (pids.includes(n.propertyId) && byDay.has(n.nightDate)) byDay.set(n.nightDate, byDay.get(n.nightDate) + n.netAmount);
  const past = days.map((d) => (d < S.today ? byDay.get(d) : 0));
  const fut = days.map((d) => (d >= S.today ? byDay.get(d) : 0));

  // Công suất
  const occRows = visibleProperties().map((p) => {
    const rooms = allRooms().filter((r) => r.propertyId === p.id);
    const pn = nights().filter((n) => n.propertyId === p.id);
    const all = D.computeKpis(pn, rooms, D.firstDay(month), D.lastDay(month));
    const pastK = isCur ? D.computeKpis(pn, rooms, D.firstDay(month), D.addDays(S.today, -1)) : all;
    const pastPct = all.availableNights ? (pastK.soldNights / all.availableNights) * 100 : 0;
    const kpi = p.occupancyKpiPct ?? 70;
    return `<div class="hbar">
      <span>${esc(p.name)}</span>
      <div class="track" title="Mức KPI ${kpi}%"><div class="fill fut" style="width:${Math.min(100, all.occupancyPct)}%"></div><div class="fill" style="width:${Math.min(100, pastPct)}%"></div><div class="kpi" style="left:${kpi}%"></div></div>
      <span class="num ${all.occupancyPct < kpi ? "neg" : ""}">${all.occupancyPct}%</span>
    </div>
    <div class="small muted" style="margin:-4px 0 6px 140px">ADR ${vnd(all.adr)} · ${all.soldNights}/${all.availableNights} đêm</div>`;
  }).join("");

  // Hôm nay
  const todayCI = allBookings().filter((b) => b.status === "CONFIRMED" && pids.includes(b.propertyId) && b.checkIn === S.today);
  const todayCO = allBookings().filter((b) => b.status === "CONFIRMED" && pids.includes(b.propertyId) && b.checkOut === S.today);
  const al = alerts();
  const roomName = (id) => allRooms().find((r) => r.id === id)?.name ?? "?";
  const listB = (arr) => arr.length ? arr.map((b) => `<div class="row small"><span class="dot" style="background:${chColor(b.channel)}"></span>${esc(propName(b.propertyId))} · ${esc(roomName(b.roomId))} — ${esc(b.guestName || "Khách")}</div>`).join("") : `<div class="small muted">Không có</div>`;

  const payback = can("fee") ? `<section class="panel"><header><div><h2>Tiến độ hoàn vốn</h2><p>Tính trên số NĐT nhận của các tháng đã khóa sổ</p></div></header>
    <div class="stack">${invs.map((i) => {
      const pb = paybackFor(i.id);
      const pct = pb.investmentTotal ? Math.max(0, Math.min(100, (pb.received / pb.investmentTotal) * 100)) : 0;
      return `<div style="display:grid;gap:6px">
        <div class="row"><b>${esc(i.name)}</b><span class="spacer"></span><span class="num small">${vnd(pb.received)} / ${vnd(pb.investmentTotal)}</span></div>
        <div class="progress"><i style="width:${pct}%"></i></div>
        <div class="small muted">Còn lại ${vnd(pb.remaining)} · ${pb.monthsLeft === null ? "Chưa xác định thời gian hoàn vốn" : pb.monthsLeft === 0 ? "Đã hoàn vốn" : `Dự kiến còn ${pb.monthsLeft} tháng (TB 3 tháng: ${vnd(pb.avgLast3)})`}</div>
      </div>`;
    }).join("")}</div></section>` : "";

  return `
    ${cards}
    <div class="grid g2">
      ${can("finance") ? `<section class="panel"><header><div><h2>Doanh thu theo đêm</h2><p><span class="dot" style="background:var(--accent)"></span>Đã ở &nbsp; <span class="dot" style="background:var(--gold)"></span>Đã đặt, chưa đến</p></div></header>${barChart(days, past, fut)}</section>` : ""}
      <section class="panel"><header><div><h2>Công suất phòng</h2><p>Phần đậm là đêm đã ở, phần nhạt là đêm đã đặt; vạch đen là mức KPI</p></div></header><div class="stack" style="gap:8px">${occRows}</div></section>
      <section class="panel"><header><h2>Hôm nay · ${dvn(S.today)}</h2></header>
        <div class="grid g2" style="gap:12px"><div><div class="lbl" style="margin-bottom:6px">Check-in (${todayCI.length})</div>${listB(todayCI)}</div>
        <div><div class="lbl" style="margin-bottom:6px">Check-out (${todayCO.length})</div>${listB(todayCO)}</div></div>
      </section>
      <section class="panel"><header><h2>Cảnh báo</h2>${al.length ? pill(String(al.length), "bad") : ""}</header>
        ${al.length ? `<div class="stack" style="gap:8px">${al.slice(0, 8).map((a) => `<div class="banner ${a.level === "bad" ? "bad" : ""}" style="margin:0">${esc(a.text)}${a.taskId ? ` <button class="btn sm" data-act="task-open" data-id="${a.taskId}">Mở</button>` : ""}</div>`).join("")}${al.length > 8 ? `<div class="small muted">và ${al.length - 8} cảnh báo khác</div>` : ""}</div>` : `<div class="small muted">Không có cảnh báo.</div>`}
      </section>
      ${payback}
    </div>`;
}

// ================= ĐẶT PHÒNG =================
export function viewBookings() {
  const mode = S.ui.bkMode || "cal";
  const pids = visiblePropertyIds();
  const head = `<div class="row" style="margin-bottom:14px">
    <div class="seg"><button data-act="ui" data-k="bkMode" data-v="cal" aria-pressed="${mode === "cal"}">Lịch phòng</button><button data-act="ui" data-k="bkMode" data-v="list" aria-pressed="${mode === "list"}">Danh sách</button></div>
    <span class="spacer"></span>
    ${can("createBooking") ? `<button class="btn primary" data-act="booking-new">+ Đơn ngoài OTA</button>` : ""}
  </div>
  <div class="row small muted" style="margin-bottom:10px">${["Airbnb", "Booking", "Agoda", "Trực tiếp"].map((c) => `<span><span class="dot" style="background:${chColor(c)}"></span>${c}</span>`).join(" &nbsp; ")}</div>`;
  return head + (mode === "cal" ? bookingCalendar(pids) : bookingList(pids));
}

function bookingCalendar(pids) {
  const days = D.eachDay(D.firstDay(S.month), D.lastDay(S.month));
  const n = days.length;
  const cols = `grid-template-columns: 120px repeat(${n}, minmax(34px, 1fr))`;
  let html = `<div class="cal-wrap"><div class="cal" style="${cols}"><div class="hd room" style="z-index:2">Phòng</div>`;
  const wd = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];
  html += days.map((d) => `<div class="hd ${d === S.today ? "today" : ""}">${wd[new Date(d + "T00:00Z").getUTCDay()]}<br>${Number(d.slice(8))}</div>`).join("");
  const showAmt = can("bookingAmounts");
  for (const p of visibleProperties()) {
    html += `<div class="prop">${esc(p.name)}</div>`;
    for (const r of p.rooms || []) {
      html += `<div class="room">${esc(r.name)}${r.closedOn ? ` <span class="pill">đóng ${dvn(r.closedOn)}</span>` : ""}</div>`;
      const bks = allBookings().filter((b) => b.roomId === r.id && b.checkOut > days[0] && b.checkIn <= days[n - 1]).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
      let i = 0;
      while (i < n) {
        const d = days[i];
        const b = bks.find((b) => b.status === "CONFIRMED" && b.checkIn <= d && b.checkOut > d) || bks.find((b) => b.status === "CANCELLED" && b.checkIn === d);
        if (b) {
          const endIdx = b.status === "CANCELLED" ? i + 1 : Math.min(n, i + Math.max(1, D.diffDays(b.checkOut, d)));
          const span = endIdx - i;
          const label = `${b.guestName || "Khách"}${showAmt && span > 2 ? " · " + short(b.netAmount) : ""}`;
          html += `<div class="cell" style="grid-column: span ${span}"><button class="bar ${b.status === "CANCELLED" ? "cx" : ""}" style="background:${chColor(b.channel)};width:calc(100% - 2px)" data-act="booking-open" data-id="${b.id}" title="${esc(b.guestName)} · ${dvn(b.checkIn)} → ${dvn(b.checkOut)}">${esc(label)}</button></div>`;
          i = endIdx;
        } else {
          html += `<div class="cell"></div>`;
          i++;
        }
      }
    }
  }
  return html + `</div></div>`;
}

function bookingList(pids) {
  const q = (S.ui.bkQ || "").toLowerCase();
  const ch = S.ui.bkCh || "";
  const st = S.ui.bkSt || "";
  const from = D.firstDay(S.month), to = D.lastDay(S.month);
  const rows = allBookings()
    .filter((b) => pids.includes(b.propertyId) && b.checkIn <= to && b.checkOut > from)
    .filter((b) => !ch || b.channel === ch)
    .filter((b) => !st || b.status === st)
    .filter((b) => !q || `${b.guestName} ${b.externalId || ""} ${b.id}`.toLowerCase().includes(q))
    .sort((a, b) => a.checkIn.localeCompare(b.checkIn));
  const showAmt = can("bookingAmounts");
  const roomName = (id) => allRooms().find((r) => r.id === id)?.name ?? "?";
  return `<div class="row" style="margin-bottom:12px">
      <input type="search" id="bk-q" data-on="ui" data-k="bkQ" placeholder="Tìm tên khách hoặc mã đơn" value="${esc(S.ui.bkQ || "")}" style="max-width:260px">
      <select id="bk-ch" data-on="ui" data-k="bkCh" style="max-width:150px"><option value="">Mọi kênh</option>${["Airbnb", "Booking", "Agoda", "Trực tiếp"].map((c) => `<option ${c === ch ? "selected" : ""}>${c}</option>`).join("")}</select>
      <select id="bk-st" data-on="ui" data-k="bkSt" style="max-width:150px"><option value="">Mọi trạng thái</option><option value="CONFIRMED" ${st === "CONFIRMED" ? "selected" : ""}>Đã xác nhận</option><option value="CANCELLED" ${st === "CANCELLED" ? "selected" : ""}>Đã hủy</option></select>
      <span class="spacer"></span><span class="small muted">${rows.length} đơn có đêm trong ${mvn(S.month).toLowerCase()}</span>
      ${showAmt ? `<button class="btn sm" data-act="export-bookings">Xuất CSV</button>` : ""}
    </div>
    <div class="panel"><div class="tbl-wrap"><table>
      <thead><tr><th>Khách</th><th>Cơ sở · Phòng</th><th>Kênh</th><th>Nhận – Trả</th><th class="n">Đêm</th>${showAmt ? `<th class="n">Gross</th><th class="n">Hoa hồng</th><th class="n">Net</th>` : ""}<th>Trạng thái</th></tr></thead>
      <tbody>${rows.map((b) => `<tr class="click" data-act="booking-open" data-id="${b.id}">
        <td><b>${esc(b.guestName || "Khách")}</b><div class="small muted">${esc(b.externalId || "Đơn ngoài OTA")}</div></td>
        <td>${esc(propName(b.propertyId))} · ${esc(roomName(b.roomId))}</td>
        <td><span class="dot" style="background:${chColor(b.channel)}"></span>${esc(b.channel)}</td>
        <td class="num">${dvn(b.checkIn)} – ${dvn(b.checkOut)}</td>
        <td class="n">${D.diffDays(b.checkOut, b.checkIn)}</td>
        ${showAmt ? `<td class="n">${vnd(b.grossAmount)}</td><td class="n muted">${vnd(b.commissionAmount)}</td><td class="n"><b>${vnd(b.netAmount)}</b></td>` : ""}
        <td>${b.status === "CANCELLED" ? pill("Đã hủy", "bad") : pill("Xác nhận", "ok")} ${b.source === "MANUAL" ? pill("Ngoài OTA") : ""}</td>
      </tr>`).join("") || `<tr><td colspan="9">${empty("Không có đơn nào khớp bộ lọc.")}</td></tr>`}</tbody>
    </table></div></div>`;
}

// ================= CHI PHÍ =================
export function viewExpenses() {
  const tab = S.ui.exTab || "list";
  const month = S.month;
  const head = `<div class="row" style="margin-bottom:14px">
    <div class="seg"><button data-act="ui" data-k="exTab" data-v="list" aria-pressed="${tab === "list"}">Chi phí cơ sở</button><button data-act="ui" data-k="exTab" data-v="common" aria-pressed="${tab === "common"}">Chi phí chung cuối tháng</button></div>
    <span class="spacer"></span>
    ${can("editExpense") ? `<button class="btn primary" data-act="expense-new">+ Nhập chi phí</button>` : ""}
  </div>`;
  return head + (tab === "common" ? commonCosts(month) : expenseList(month));
}

function expenseList(month) {
  const pids = visiblePropertyIds();
  const cat = S.ui.exCat || "";
  const pay = S.ui.exPay || "";
  const cats = S.data.categories;
  const rows = S.data.expenses
    .filter((e) => e.month === month && e.propertyId && pids.includes(e.propertyId))
    .filter((e) => !cat || e.categoryId === cat)
    .filter((e) => !pay || e.paymentStatus === pay)
    .sort((a, b) => (a.incurredOn || "").localeCompare(b.incurredOn || ""));
  const sel = S.ui.exSel || [];
  const total = rows.reduce((s, e) => s + e.amount, 0);
  const editable = can("editExpense");

  // Tổng chưa thanh toán theo NĐT (mọi tháng)
  const unpaid = visibleInvestors().map((i) => {
    const ids = S.data.properties.filter((p) => p.investorId === i.id && pids.includes(p.id)).map((p) => p.id);
    const list = S.data.expenses.filter((e) => ids.includes(e.propertyId) && e.paymentStatus === "UNPAID");
    return { i, amount: list.reduce((s, e) => s + e.amount, 0), count: list.length };
  });

  return `<div class="cards">${unpaid.map((u) => stat(`Chưa thanh toán · ${esc(u.i.name)}`, vnd(u.amount), `${u.count} khoản, mọi tháng`)).join("")}
      ${stat(`Tổng chi phí ${mvn(month).toLowerCase()}`, vnd(total), `${rows.length} khoản theo bộ lọc`)}</div>
    <div class="row" style="margin-bottom:12px">
      <select id="ex-cat" data-on="ui" data-k="exCat" style="max-width:190px"><option value="">Mọi loại chi phí</option>${cats.map((c) => `<option value="${c.id}" ${c.id === cat ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select>
      <select id="ex-pay" data-on="ui" data-k="exPay" style="max-width:190px"><option value="">Mọi trạng thái</option><option value="UNPAID" ${pay === "UNPAID" ? "selected" : ""}>Chưa thanh toán</option><option value="PAID" ${pay === "PAID" ? "selected" : ""}>Đã thanh toán</option></select>
      <span class="spacer"></span>
      ${editable && sel.length ? `<button class="btn primary sm" data-act="expense-markpaid">Đánh dấu đã thanh toán (${sel.length})</button>` : ""}
    </div>
    <div class="panel"><div class="tbl-wrap"><table>
      <thead><tr>${editable ? `<th><input type="checkbox" id="ex-all" data-act="expense-selall" aria-label="Chọn tất cả" ${sel.length && sel.length === rows.filter((e) => e.paymentStatus === "UNPAID").length ? "checked" : ""}></th>` : ""}<th>Ngày</th><th>Cơ sở</th><th>Loại</th><th>Mô tả</th><th class="n">Số tiền</th><th>Thanh toán</th></tr></thead>
      <tbody>${rows.map((e) => `<tr>
        ${editable ? `<td>${e.paymentStatus === "UNPAID" ? `<input type="checkbox" id="exs-${e.id}" data-act="expense-sel" data-id="${e.id}" ${sel.includes(e.id) ? "checked" : ""} aria-label="Chọn">` : ""}</td>` : ""}
        <td class="num">${dvn(e.incurredOn)}</td>
        <td>${esc(propName(e.propertyId))}</td>
        <td>${esc(byId("categories", e.categoryId)?.name || "—")}</td>
        <td>${esc(e.description)}${(e.receiptIds || []).length ? ` <span class="pill">${e.receiptIds.length} ảnh</span>` : ""}${e.taskId ? ` <span class="pill">gắn việc</span>` : ""}</td>
        <td class="n"><b>${vnd(e.amount)}</b></td>
        <td>${e.paymentStatus === "PAID" ? pill("Đã TT", "ok") : pill("Chưa TT", "warn")} ${editable ? `<button class="btn sm" data-act="expense-edit" data-id="${e.id}">Sửa</button>` : ""}</td>
      </tr>`).join("") || `<tr><td colspan="7">${empty(`Chưa có chi phí nào trong ${mvn(month).toLowerCase()}.`, editable ? `<button class="btn primary" data-act="expense-new">+ Nhập chi phí đầu tiên</button>` : "")}</td></tr>`}
      ${rows.length ? `<tr class="total"><td colspan="${editable ? 5 : 4}">Tổng</td><td class="n">${vnd(total)}</td><td></td></tr>` : ""}</tbody>
    </table></div></div>`;
}

function commonCosts(month) {
  const list = S.data.expenses.filter((e) => e.month === month && e.propertyId === null);
  const total = list.reduce((s, e) => s + e.amount, 0);
  const finalized = isCommonFinalized(month);
  const locked = isAnyLocked(month);
  const c = D.commonCostForMonth({ month, expenses: S.data.expenses, rooms: allRooms(), finalized: true });
  const roomsBy = D.activeRoomCountByProperty(allRooms(), month);
  const totalRooms = Object.values(roomsBy).reduce((s, n) => s + n, 0);
  const prov = D.commonCostForMonth({ month, expenses: S.data.expenses, rooms: allRooms(), finalized: false });
  const editable = can("commonCost") && !finalized && !locked;
  return `<div class="grid g2">
    <section class="panel"><header><div><h2>Khoản chi phí chung · ${mvn(month)}</h2><p>Kế toán kê khai vào cuối tháng. Chia đều theo số phòng trên toàn hệ thống.</p></div>
      ${finalized ? pill("Đã hoàn tất kê khai", "ok") : pill("Đang kê khai", "fc")}</header>
      <div class="tbl-wrap"><table><thead><tr><th>Loại</th><th>Mô tả</th><th class="n">Số tiền</th><th></th></tr></thead><tbody>
      ${list.map((e) => `<tr><td>${esc(byId("categories", e.categoryId)?.name || "—")}</td><td>${esc(e.description)}</td><td class="n">${vnd(e.amount)}</td><td>${editable ? `<button class="btn sm" data-act="expense-edit" data-id="${e.id}">Sửa</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="muted small">Chưa có khoản chi phí chung nào.</td></tr>`}
      <tr class="total"><td colspan="2">Tổng</td><td class="n">${vnd(total)}</td><td></td></tr></tbody></table></div>
      <div class="row" style="margin-top:12px">
        ${editable ? `<button class="btn" data-act="expense-new" data-common="1">+ Thêm khoản chung</button><span class="spacer"></span><button class="btn primary" data-act="common-finalize">Hoàn tất kê khai</button>` : ""}
        ${finalized && can("commonCost") && !locked ? `<span class="spacer"></span><button class="btn" data-act="common-reopen">Mở lại kê khai</button>` : ""}
        ${locked ? `<span class="small muted">Tháng đã khóa sổ, không sửa được chi phí chung.</span>` : ""}
      </div>
    </section>
    <section class="panel"><header><div><h2>Phân bổ cho từng cơ sở</h2><p>${totalRooms} phòng hoạt động trong tháng · ${vnd(totalRooms ? Math.floor(total / totalRooms) : 0)} mỗi phòng</p></div></header>
      <div class="tbl-wrap"><table><thead><tr><th>Cơ sở</th><th class="n">Phòng</th><th class="n">Phân bổ</th>${!finalized ? `<th class="n">Tạm tính đang dùng</th>` : ""}</tr></thead><tbody>
      ${S.data.properties.filter((p) => roomsBy[p.id]).map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${roomsBy[p.id]}</td><td class="n">${vnd(c.perProperty[p.id] || 0)}</td>${!finalized ? `<td class="n gold">${vnd(prov.perProperty[p.id] || 0)}</td>` : ""}</tr>`).join("")}
      </tbody></table></div>
      ${!finalized ? `<p class="small muted">Khi chưa hoàn tất kê khai, báo cáo dùng số tạm tính = chi phí chung mỗi phòng của ${mvn(D.prevMonth(month)).toLowerCase()} × số phòng.</p>` : ""}
    </section></div>`;
}

// ================= QUYẾT TOÁN =================
export function viewSettle() {
  const invs = visibleInvestors();
  if (!invs.length) return empty("Không có nhà đầu tư nào trong phạm vi được xem.");
  const invId = invs.some((i) => i.id === S.ui.stInv) ? S.ui.stInv : invs[0].id;
  const month = S.month;
  const s = settlement(invId, month);
  const cur = currentMonth();
  const status = s.locked ? pill("Đã khóa sổ", "ok") : month >= cur ? pill("Tháng đang chạy", "fc") : pill("Nháp", "warn");
  const lockCheck = D.canLockMonth(month, S.today, isCommonFinalized(month));
  const adjs = S.data.adjustments.filter((a) => a.appliedMonth === month && s.lines.some((l) => l.propertyId === a.propertyId));

  // Ma trận tháng × NĐT
  const months = [];
  const firstMonth = S.data.properties.map((p) => p.investmentStartMonth).filter(Boolean).sort()[0] || D.prevMonth(cur);
  for (let m = firstMonth; m <= cur; m = D.nextMonth(m)) months.push(m);
  const matrix = `<section class="panel"><header><h2>Trạng thái quyết toán</h2></header><div class="tbl-wrap"><table>
    <thead><tr><th>Tháng</th>${invs.map((i) => `<th>${esc(i.name)}</th>`).join("")}</tr></thead>
    <tbody>${months.reverse().map((m) => `<tr>${`<td class="num">${mvn(m)}</td>`}${invs.map((i) => {
      const st = isLocked(i.id, m) ? pill("Đã khóa", "ok") : m >= cur ? pill("Đang chạy", "fc") : pill("Nháp", "warn");
      const net = settlement(i.id, m).investorNet;
      return `<td><button class="btn sm" data-act="settle-pick" data-inv="${i.id}" data-m="${m}" ${m === month && i.id === invId ? 'style="border-color:var(--accent)"' : ""}>${st} <span class="num ${signCls(net)}">${short(Math.abs(net))}${net < 0 ? " âm" : ""}</span></button></td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div></section>`;

  const pb = paybackFor(invId);
  return `<div class="row" style="margin-bottom:14px">
      ${invs.length > 1 ? `<div class="seg">${invs.map((i) => `<button data-act="ui" data-k="stInv" data-v="${i.id}" aria-pressed="${i.id === invId}">${esc(i.name)}</button>`).join("")}</div>` : `<h2>${esc(invName(invId))}</h2>`}
      ${status}
      <span class="spacer"></span>
      <button class="btn sm" data-act="settle-export" data-inv="${invId}">Xuất CSV</button>
      ${can("lock") && !s.locked ? `<button class="btn primary" data-act="settle-lock" data-inv="${invId}" ${lockCheck.ok ? "" : "disabled"} title="${esc(lockCheck.reason || "")}">Khóa sổ ${mvn(month).toLowerCase()}</button>` : ""}
      ${can("lock") && s.locked ? `<button class="btn danger" data-act="settle-unlock" data-inv="${invId}">Mở khóa…</button>` : ""}
    </div>
    ${!s.locked && !lockCheck.ok && can("lock") ? `<div class="banner info">Chưa khóa được: ${esc(lockCheck.reason)}.</div>` : ""}
    ${!s.locked && s.commonProvisional ? `<div class="banner">Chi phí chung đang là số tạm tính. Số liệu sẽ thay đổi khi kế toán hoàn tất kê khai.</div>` : ""}
    <div class="cards">
      ${stat("Doanh thu", vnd(s.totalRevenue))}
      ${stat("Chi phí trực tiếp", vnd(s.totalDirectCost))}
      ${stat("Chi phí chung phân bổ", vnd(s.totalCommonCost), s.commonProvisional && !s.locked ? "Tạm tính" : "")}
      ${stat("Lợi nhuận", `<span class="${signCls(s.totalProfit)}">${vnd(s.totalProfit)}</span>`)}
      ${stat(`Phí quản lý ${feePct()}%`, vnd(s.managementFee), s.totalProfit <= 0 ? "Lỗ nên không thu phí" : "")}
      ${stat("NĐT nhận", `<span class="${signCls(s.investorNet)}">${vnd(s.investorNet)}</span>`)}
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)">
      <section class="panel"><header><div><h2>Chi tiết theo cơ sở · ${mvn(month)}</h2><p>Phí quản lý tính trên tổng lợi nhuận của NĐT; cơ sở lãi bù cơ sở lỗ.</p></div></header>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Cơ sở</th><th class="n">Phòng</th><th class="n">Công suất</th><th class="n">Doanh thu đêm</th><th class="n">Điều chỉnh</th><th class="n">CP trực tiếp</th><th class="n">CP chung</th><th class="n">Lợi nhuận</th></tr></thead>
          <tbody>${s.lines.map((l) => `<tr>
            <td>${esc(propName(l.propertyId))}</td><td class="n">${l.roomCount}</td>
            <td class="n">${l.availableNights ? Math.round((l.soldNights / l.availableNights) * 1000) / 10 : 0}%</td>
            <td class="n">${vnd(l.nightRevenue)}</td><td class="n ${signCls(l.adjustments)}">${l.adjustments ? vnd(l.adjustments) : "—"}</td>
            <td class="n">${vnd(l.directCost)}</td><td class="n">${vnd(l.commonCostAlloc)}</td><td class="n"><b class="${signCls(l.profit)}">${vnd(l.profit)}</b></td></tr>`).join("")}
            <tr class="total"><td colspan="7">Lợi nhuận tổng của NĐT</td><td class="n ${signCls(s.totalProfit)}">${vnd(s.totalProfit)}</td></tr>
            <tr><td colspan="7">Phí quản lý (${feePct()}% nếu lãi)</td><td class="n">− ${vnd(s.managementFee)}</td></tr>
            <tr class="total"><td colspan="7">NĐT nhận</td><td class="n ${signCls(s.investorNet)}">${vnd(s.investorNet)}</td></tr>
          </tbody></table></div>
        ${adjs.length ? `<h3 style="margin-top:14px">Khoản điều chỉnh ghi vào tháng này</h3><div class="tbl-wrap"><table><tbody>${adjs.map((a) => `<tr><td>${esc(propName(a.propertyId))}</td><td class="small">${esc(a.reason)} · từ ${mvn(a.originalMonth)}</td><td class="n ${signCls(a.amount)}">${vnd(a.amount)}</td></tr>`).join("")}</tbody></table></div>` : ""}
        ${s.locked ? `<p class="small muted">Khóa lúc ${esc(String(s.lockedAt || "").replace("T", " ").slice(0, 16))} bởi ${esc(s.lockedBy || "")}. Số liệu đọc từ bản đã chốt, không tính lại.</p>` : ""}
        ${(s.unlockLog || []).length ? `<p class="small muted">Lịch sử mở khóa: ${s.unlockLog.map((u) => `${esc(u.at.replace("T", " "))} · ${esc(u.by)}: ${esc(u.reason)}`).join("; ")}</p>` : ""}
      </section>
      <section class="panel"><header><h2>Hoàn vốn</h2></header>
        <div class="stack" style="gap:10px">
          <div class="row"><span class="muted">Tổng vốn đầu tư</span><span class="spacer"></span><b class="num">${vnd(pb.investmentTotal)}</b></div>
          <div class="row"><span class="muted">Đã nhận lũy kế</span><span class="spacer"></span><b class="num">${vnd(pb.received)}</b></div>
          <div class="row"><span class="muted">Vốn còn lại</span><span class="spacer"></span><b class="num">${vnd(pb.remaining)}</b></div>
          <div class="progress"><i style="width:${pb.investmentTotal ? Math.max(0, Math.min(100, (pb.received / pb.investmentTotal) * 100)) : 0}%"></i></div>
          <div class="row"><span class="muted">TB 3 tháng đã khóa</span><span class="spacer"></span><span class="num">${pb.avgLast3 === null ? "—" : vnd(pb.avgLast3)}</span></div>
          <div class="row"><span class="muted">Thời gian hoàn vốn dự kiến</span><span class="spacer"></span><b>${pb.monthsLeft === null ? "Chưa xác định" : pb.monthsLeft === 0 ? "Đã hoàn vốn" : pb.monthsLeft + " tháng"}</b></div>
        </div>
      </section>
    </div>
    <div style="margin-top:16px">${matrix}</div>`;
}

export { stat, pill, empty, chColor, short, barChart, icon };

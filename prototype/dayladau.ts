// @ts-nocheck
// Kết nối Dayladau trong bản chạy thử. Trang không gọi được máy chủ ngoài, nên luồng là:
// app tạo link API (host ID + token) → người dùng mở link, copy JSON → dán vào app → map và nhập đơn.
// Token lưu trong vùng riêng của người nhập (data/users/<id>/…), người xem khác không đọc được.
import { mapDayladauOrder, netOf, CANCELLED_STATUS } from "../lib/dayladau/mapping";
import { ordersUrl, PAGE_SIZE } from "../lib/dayladau/client";
import { D, S, esc, vnd, dvn, byId, save, toast, allBookings, bookingById, importBookings, config, allRooms } from "./core";

const tokens = {}; // invId → token (bộ nhớ trang)
const loaded = new Set();
export const DLD = { invId: null, orders: new Map(), pages: 3, error: "", result: null };

async function uidOf() {
  try { return (await S.user?.id?.()) || null; } catch { return null; }
}

export async function loadToken(invId) {
  if (loaded.has(invId)) return tokens[invId] || "";
  loaded.add(invId);
  if (S.mode === "live") {
    const uid = await uidOf();
    if (uid) {
      try {
        const snap = await S.db.collection(`data/users/${uid}`).doc(`dld-${invId}`).get();
        if (snap.exists) tokens[invId] = snap.data().token || "";
      } catch {}
    }
  }
  return tokens[invId] || "";
}

export async function saveConnection(invId, hostId, token) {
  const inv = byId("investors", invId);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(hostId)) throw new Error("Host ID chỉ gồm chữ, số, - và _");
  if (token && !/^[A-Za-z0-9._~-]{16,512}$/.test(token)) throw new Error("Access token có khoảng trắng hoặc ký tự lạ");
  const dup = S.data.investors.find((i) => i.id !== invId && i.dayladauHostId === hostId);
  if (dup) throw new Error(`Host ID này đang gắn với ${dup.name}`);
  await save("investors", { ...inv, dayladauHostId: hostId, hasToken: !!(token || inv.hasToken), tokenHint: token ? "…" + token.slice(-4) : inv.tokenHint || "" });
  if (token) {
    tokens[invId] = token;
    loaded.add(invId);
    if (S.mode === "live") {
      const uid = await uidOf();
      if (!uid) throw new Error("Không lưu được token: trang chưa xác định được tài khoản của bạn");
      await S.db.collection(`data/users/${uid}`).doc(`dld-${invId}`).set({ token, savedAt: new Date().toISOString() });
    }
  }
}

// ---------- Đọc dữ liệu dán vào ----------
export function addPasted(text) {
  let data;
  try { data = JSON.parse(text.trim()); } catch { throw new Error("Nội dung dán vào không phải JSON. Mở link, chọn toàn bộ trang (Ctrl+A), copy rồi dán lại."); }
  const orders = Array.isArray(data) ? data : data?.orders;
  if (!Array.isArray(orders)) throw new Error(data?.message || data?.error ? `Dayladau báo lỗi: ${data.message || data.error}. Kiểm tra host ID và token.` : "Không thấy danh sách orders trong dữ liệu.");
  let added = 0;
  for (const o of orders) if (o?.id !== undefined) { if (!DLD.orders.has(String(o.id))) added++; DLD.orders.set(String(o.id), o); }
  return { count: orders.length, added };
}

function invRooms(invId) {
  const pids = S.data.properties.filter((p) => p.investorId === invId).map((p) => p.id);
  return allRooms().filter((r) => pids.includes(r.propertyId));
}

/** Phân tích các đơn đã dán: listing, trạng thái, đơn mới / thay đổi / không đổi. */
export function analyse(invId) {
  const rooms = invRooms(invId);
  const listings = new Map(), statuses = new Map();
  const rows = [];
  let bad = 0;
  const pct = config().commission || {};
  for (const raw of DLD.orders.values()) {
    let m;
    try { m = mapDayladauOrder(raw); } catch { bad++; continue; }
    const room = rooms.find((r) => r.dayladauRoomId && (r.dayladauRoomId === m.listingKey || r.dayladauRoomId === m.listingName));
    const l = listings.get(m.listingKey) || { key: m.listingKey, name: m.listingName, orders: 0, roomId: room?.id || "" };
    l.orders++; listings.set(m.listingKey, l);
    const st = statuses.get(m.rawStatus) || { status: m.rawStatus, orders: 0, cancelled: m.status === "CANCELLED" };
    st.orders++; statuses.set(m.rawStatus, st);
    const prev = allBookings().find((b) => b.externalId === m.externalId);
    const { commission, net } = netOf(m, Number(pct[m.channel] ?? 0));
    const next = room && {
      ...(prev || {}), id: prev?.id || `dld-${m.externalId}`, source: "DAYLADAU", externalId: m.externalId, propertyId: room.propertyId, roomId: room.id,
      channel: m.channel, guestName: m.guestName, bookedAt: m.bookedAt, checkIn: m.checkIn, checkOut: m.checkOut,
      grossAmount: m.grossAmount, commissionAmount: commission, netAmount: net, status: m.status, rentalType: m.rentalType, transferProof: "",
    };
    let kind = !room ? "unmapped" : !prev ? "new" : ["roomId", "checkIn", "checkOut", "grossAmount", "commissionAmount", "netAmount", "status"].some((k) => prev[k] !== next[k]) ? "changed" : "same";
    rows.push({ m, next, kind });
  }
  const count = (k) => rows.filter((r) => r.kind === k).length;
  return { listings: [...listings.values()].sort((a, b) => a.name.localeCompare(b.name, "vi")), statuses: [...statuses.values()], rows, bad, n: { new: count("new"), changed: count("changed"), same: count("same"), unmapped: count("unmapped") } };
}

export async function mapListing(invId, listingKey, roomId) {
  const rooms = invRooms(invId);
  for (const p of S.data.properties.filter((p) => p.investorId === invId)) {
    let changed = false;
    const rs = (p.rooms || []).map((r) => {
      if (r.dayladauRoomId === listingKey && r.id !== roomId) { changed = true; return { ...r, dayladauRoomId: "" }; }
      if (r.id === roomId && r.dayladauRoomId !== listingKey) { changed = true; return { ...r, dayladauRoomId: listingKey }; }
      return r;
    });
    if (changed) await save("properties", { ...p, rooms: rs });
  }
  if (roomId && !rooms.some((r) => r.id === roomId)) throw new Error("Phòng không thuộc nhà đầu tư này");
}

export async function runImport(invId) {
  const a = analyse(invId);
  const todo = a.rows.filter((r) => r.kind === "new" || r.kind === "changed").map((r) => r.next);
  if (!todo.length) return { created: 0, updated: 0, adjustments: 0, skipped: a.n.unmapped };
  const res = await importBookings(todo, "SYNC", "Đồng bộ Dayladau");
  const inv = byId("investors", invId);
  await save("investors", { ...inv, lastSyncAt: new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 16), lastSyncResult: `${res.created} mới, ${res.updated} cập nhật` });
  return { ...res, skipped: a.n.unmapped };
}

// ---------- Giao diện ----------
export function viewDayladau() {
  const invs = S.data.investors;
  if (!invs.length) return `<div class="empty">Chưa có nhà đầu tư. Thêm ở tab Nhà đầu tư.</div>`;
  const invId = invs.some((i) => i.id === DLD.invId) ? DLD.invId : invs[0].id;
  DLD.invId = invId;
  const inv = byId("investors", invId);
  const token = tokens[invId] || "";
  const hasConn = inv.dayladauHostId && (token || inv.hasToken);
  const a = DLD.orders.size ? analyse(invId) : null;
  const props = S.data.properties.filter((p) => p.investorId === invId);

  const pageLinks = inv.dayladauHostId && token
    ? Array.from({ length: DLD.pages }, (_, i) => `<a class="btn sm" href="${esc(ordersUrl(inv.dayladauHostId, token, i * PAGE_SIZE))}" target="_blank" rel="noopener noreferrer">Trang ${i + 1} (đơn ${i * PAGE_SIZE + 1}–${(i + 1) * PAGE_SIZE})</a>`).join("") +
      `<button class="btn sm" data-act="dld-more">+ Thêm trang</button>`
    : "";

  return `<div class="row" style="margin-bottom:14px"><div class="seg">${invs.map((i) => `<button data-act="dld-inv" data-id="${i.id}" aria-pressed="${i.id === invId}">${esc(i.name)}</button>`).join("")}</div></div>
  <div class="grid g2">
    <section class="panel"><header><div><h2>1. Thông tin kết nối</h2><p>Host ID và access token Dayladau của ${esc(inv.name)}</p></div>${hasConn ? `<span class="pill ok">Đã có</span>` : `<span class="pill warn">Chưa có</span>`}</header>
      <div class="form-grid">
        <label class="field"><span>Host ID</span><input type="text" id="dld-host" value="${esc(inv.dayladauHostId || "")}" placeholder="vd: usc62mtlkh" autocomplete="off"></label>
        <label class="field"><span>Access token ${inv.hasToken ? `(đang lưu ${esc(inv.tokenHint || "")})` : ""}</span><input type="password" id="dld-token" placeholder="${inv.hasToken ? "Để trống nếu không đổi" : "Dán x_access_token"}" autocomplete="new-password"></label>
        <p class="hint full">Token chỉ lưu trong vùng riêng của tài khoản bạn trên trang này; người được chia sẻ trang không đọc được. ${inv.hasToken && !token ? "Token được lưu từ tài khoản khác hoặc chưa tải; nhập lại nếu cần tạo link." : ""}</p>
        <p class="err full" id="dld-err">${esc(DLD.error)}</p>
      </div>
      <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn primary" data-act="dld-save">Lưu thông tin</button></div>
    </section>

    <section class="panel"><header><div><h2>2. Lấy dữ liệu đơn</h2><p>Mỗi trang 100 đơn, mới nhất trước</p></div>${DLD.orders.size ? `<span class="pill fc">${DLD.orders.size} đơn đã đọc</span>` : ""}</header>
      ${pageLinks ? `<ol class="small" style="margin:0 0 10px;padding-left:18px;display:grid;gap:4px">
          <li>Bấm mở từng trang bên dưới (mở tab mới, hiện dữ liệu dạng chữ).</li>
          <li>Trong tab đó bấm Ctrl+A rồi Ctrl+C (điện thoại: chọn tất cả, sao chép).</li>
          <li>Dán vào ô bên dưới, bấm Đọc dữ liệu. Trang nào có ít hơn 100 đơn là trang cuối.</li></ol>
        <div class="row" style="margin-bottom:10px">${pageLinks}</div>
        <textarea id="dld-paste" placeholder='Dán nội dung trang ở đây, bắt đầu bằng {"orders":[…'></textarea>
        <div class="row" style="margin-top:8px"><input type="file" id="dld-file" accept=".json,.txt,application/json" data-act-change="dld-file" style="max-width:220px"><span class="spacer"></span>
          ${DLD.orders.size ? `<button class="btn sm" data-act="dld-clear">Xóa dữ liệu đã đọc</button>` : ""}<button class="btn primary" data-act="dld-read">Đọc dữ liệu</button></div>`
      : `<p class="small muted">Nhập host ID và access token ở bước 1 để tạo link lấy dữ liệu.</p>`}
    </section>
  </div>

  ${a ? `<section class="panel" style="margin-top:16px"><header><div><h2>3. Gắn listing với phòng</h2><p>Đơn của listing chưa gắn phòng sẽ bị bỏ qua</p></div></header>
      ${!props.length ? `<div class="banner">Nhà đầu tư này chưa có cơ sở. Tạo cơ sở và phòng ở tab Cơ sở & phòng trước.</div>` : ""}
      <div class="tbl-wrap"><table><thead><tr><th>Listing Dayladau</th><th class="n">Đơn</th><th>Phòng</th></tr></thead><tbody>
      ${a.listings.map((l, i) => `<tr><td><b>${esc(l.name)}</b><div class="small muted">mã ${esc(l.key)}</div></td><td class="n">${l.orders}</td>
        <td><select id="dld-map-${i}" data-act-change="dld-map" data-key="${esc(l.key)}" style="max-width:280px"><option value="">— Chưa gắn —</option>
        ${props.map((p) => `<optgroup label="${esc(p.name)}">${(p.rooms || []).map((r) => `<option value="${r.id}" ${r.id === l.roomId ? "selected" : ""}>${esc(r.name)}${r.dayladauRoomId && r.dayladauRoomId !== l.key ? " (đang gắn listing khác)" : ""}</option>`).join("")}</optgroup>`).join("")}</select></td></tr>`).join("")}
      </tbody></table></div>
    </section>
    <div class="grid g2" style="margin-top:16px">
      <section class="panel"><header><div><h2>Trạng thái đơn</h2><p>Kiểm tra trạng thái nào được coi là hủy</p></div></header>
        <table><tbody>${a.statuses.map((s) => `<tr><td>${esc(s.status || "(trống)")}</td><td class="n">${s.orders}</td><td>${s.cancelled ? `<span class="pill bad">Hủy, doanh thu 0</span>` : `<span class="pill ok">Có doanh thu</span>`}</td></tr>`).join("")}</tbody></table>
      </section>
      <section class="panel"><header><div><h2>Đối chiếu tiền host</h2><p>So với cột "Amount host" trong Google Sheet</p></div></header>
        <table><tbody>${a.rows.filter((r) => r.m.status === "CONFIRMED").slice(0, 5).map((r) => `<tr><td class="small">${esc(r.m.externalId)}<br>${esc(r.m.listingName)}</td><td class="small num">${dvn(r.m.checkIn)} → ${dvn(r.m.checkOut)}</td><td class="n small">Khách trả ${vnd(r.m.grossAmount)}<br><b>Host nhận ${vnd(r.m.hostAmount)}</b></td></tr>`).join("")}</tbody></table>
      </section>
    </div>
    <section class="panel" style="margin-top:16px"><header><h2>4. Nhập vào hệ thống</h2></header>
      <div class="cards">
        <div class="stat"><span class="lbl">Đơn mới</span><span class="v">${a.n.new}</span></div>
        <div class="stat"><span class="lbl">Có thay đổi</span><span class="v">${a.n.changed}</span></div>
        <div class="stat"><span class="lbl">Không đổi</span><span class="v">${a.n.same}</span></div>
        <div class="stat"><span class="lbl">Chưa gắn phòng</span><span class="v ${a.n.unmapped ? "neg" : ""}">${a.n.unmapped}</span></div>
      </div>
      ${a.bad ? `<p class="small muted">${a.bad} đơn thiếu ngày nhận/trả phòng, bỏ qua.</p>` : ""}
      ${DLD.result ? `<div class="banner info">${esc(DLD.result)}</div>` : ""}
      <div class="row"><span class="small muted">Đơn thay đổi làm ảnh hưởng tháng đã khóa sổ sẽ tự sinh khoản điều chỉnh vào tháng mở kế tiếp.</span><span class="spacer"></span>
        <button class="btn primary" data-act="dld-import" ${a.n.new + a.n.changed ? "" : "disabled"}>Nhập ${a.n.new + a.n.changed} đơn</button></div>
    </section>` : ""}
  ${inv.lastSyncAt ? `<p class="small muted" style="margin-top:12px">Lần nhập gần nhất: ${esc(inv.lastSyncAt.replace("T", " "))} · ${esc(inv.lastSyncResult || "")}</p>` : ""}
  <p class="small muted" style="margin-top:8px">Bản chính thức (Next.js) tự gọi API lúc 06:00 hằng ngày bằng đúng thông tin này, không cần dán tay.</p>`;
}

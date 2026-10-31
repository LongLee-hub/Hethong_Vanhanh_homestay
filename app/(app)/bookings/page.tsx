import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { monthParam, visibleProperties } from "@/lib/queries";
import { filteredBookings, filterQuery, filterScope, parseBookingFilter } from "./filter";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { manualBookingAction } from "../actions";
import { canViewLiveOrders, liveOrdersForMonth, type LiveSyncState } from "@/lib/dayladau/live";
import { BookingChanges } from "./changes";
import { SyncMonth, type SyncAccount } from "./sync-month";
import { and, eq } from "drizzle-orm";
import { dayladauAccounts } from "@/lib/db/schema";

// Nút "Lấy tất cả đơn tháng X" đọc toàn bộ lịch sử đơn của host (có host hơn 36.000 đơn), cần thời gian như job đồng bộ
export const maxDuration = 300;

const CHANNEL: Record<string, string> = { Direct: "Trực tiếp" };
const SYNC: Record<LiveSyncState, [string, string]> = {
  SYNCED: ["Đã có trong hệ thống", "ok"],
  NOT_SYNCED: ["Chưa đồng bộ", "warn"],
  UNMAPPED: ["Phòng chưa gắn", "bad"],
};

type Src = "db" | "changes" | "api";

/** Tài khoản Dayladau đang bật, để chọn host ID khi lấy đơn theo tháng. */
async function syncAccounts(): Promise<SyncAccount[]> {
  return getDb().select({ id: dayladauAccounts.id, label: dayladauAccounts.label, hostId: dayladauAccounts.hostId }).from(dayladauAccounts).where(and(eq(dayladauAccounts.active, true), eq(dayladauAccounts.payoutOnly, false))).orderBy(dayladauAccounts.label);
}

/** Các cách xem đơn: đơn đã lưu trong hệ thống, đơn vừa cập nhật, hoặc đọc trực tiếp từ API Dayladau. */
function SourceTabs({ month, src, live }: { month: string; src: Src; live: boolean }) {
  return (
    <div className="chips" style={{ width: "100%" }}>
      <Link className="chip" aria-pressed={src === "db"} href={`/bookings?month=${month}`}>Trong hệ thống</Link>
      <Link className="chip" aria-pressed={src === "changes"} href={`/bookings?month=${month}&src=changes`}>Đơn đã cập nhật</Link>
      {live && <Link className="chip" aria-pressed={src === "api"} href={`/bookings?month=${month}&src=api`}>Từ Dayladau</Link>}
    </div>
  );
}

async function LiveBookings({ month, user }: { month: string; user: Parameters<typeof liveOrdersForMonth>[1] }) {
  const { orders, errors, unreadable } = await liveOrdersForMonth(getDb(), user, month);
  const ok = orders.filter((o) => o.status === "CONFIRMED");
  const count = (s: LiveSyncState) => orders.filter((o) => o.sync === s).length;
  const multiAcc = new Set(orders.map((o) => `${o.investorName} · ${o.accountLabel}`)).size > 1;
  return (
    <>
      {errors.map((e) => <div key={`${e.investorName}|${e.accountLabel}`} className="banner bad">{e.investorName} · {e.accountLabel}: {e.message}</div>)}
      <div className="cards">
        <div className="stat"><span className="lbl">Đơn trên Dayladau</span><span className="v">{orders.length}</span><span className="s">{ok.length} xác nhận · {orders.length - ok.length} hủy</span></div>
        <div className="stat"><span className="lbl">Tiền host nhận</span><span className="v">{vnd(ok.reduce((s, o) => s + o.hostAmount, 0))}</span><span className="s">Các đơn xác nhận, cả phần kéo sang tháng khác</span></div>
        <div className="stat"><span className="lbl">Đã có trong hệ thống</span><span className="v">{count("SYNCED")}</span><span className="s">{count("NOT_SYNCED")} chưa đồng bộ · {count("UNMAPPED")} phòng chưa gắn</span></div>
      </div>
      {count("UNMAPPED") > 0 && <div className="banner">Đơn của phòng chưa gắn sẽ không được tính doanh thu. Gắn phòng ở mục <Link href="/properties">Cơ sở &amp; phòng</Link>, rồi đồng bộ lại.</div>}
      <section className="panel">
        <header><div><h2>Đơn đọc trực tiếp từ Dayladau</h2><p>Lấy lúc {new Date().toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" })}. Chỉ để xem, không ghi vào hệ thống.{unreadable ? ` Bỏ qua ${unreadable} đơn đọc lỗi.` : ""}</p></div></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Khách</th><th>Phòng</th><th>Kênh bán</th><th>Nhận – trả phòng</th><th className="n">Khách trả</th><th className="n">Host nhận</th><th>Trạng thái</th><th>Hệ thống</th></tr></thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.externalId}>
                <td><b>{o.guestName ?? "Khách"}</b><div className="small muted">{o.externalId}{multiAcc ? ` · ${o.investorName} · ${o.accountLabel}` : ""}</div></td>
                <td>{o.roomLabel ?? <span className="muted">{o.listingName}</span>}</td>
                <td><span className="pill">{CHANNEL[o.channel] ?? o.channel}</span></td>
                <td className="num">{D.formatDateVN(o.checkIn)} – {D.formatDateVN(o.checkOut)}</td>
                <td className="n">{vnd(o.grossAmount)}</td>
                <td className="n"><b>{o.hostAmount ? vnd(o.hostAmount) : "—"}</b></td>
                <td>{o.status === "CANCELLED" ? <span className="pill bad">Đã hủy</span> : <span className="pill ok">Đã xác nhận</span>}<div className="small muted">{o.rawStatus}</div></td>
                <td><span className={`pill ${SYNC[o.sync][1]}`}>{SYNC[o.sync][0]}</span></td>
              </tr>
            ))}
            {!orders.length && <tr><td colSpan={8} className="muted small">{errors.length ? "Không đọc được đơn từ Dayladau." : "Dayladau không có đơn nào trong tháng."}</td></tr>}
          </tbody>
        </table></div>
      </section>
    </>
  );
}

export default async function Bookings({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewBookings")) return <NoAccess />;
  const sp = await searchParams;
  const month = monthParam(sp.month);
  const live = canViewLiveOrders(user);
  if (live && sp.src === "api") {
    return (
      <>
        <div className="topbar"><h1>Đặt phòng</h1><MonthNav month={month} path="/bookings" extra="&src=api" /><SourceTabs month={month} src="api" live /></div>
        {can(user, "admin") && <SyncMonth month={month} label={D.formatMonthVN(month)} accounts={await syncAccounts()} />}
        <LiveBookings month={month} user={user} />
      </>
    );
  }
  if (sp.src === "changes") {
    return (
      <>
        <div className="topbar"><h1>Đặt phòng</h1><p className="sub">Đơn mới, đơn đổi ngày, phòng hoặc số tiền, và đơn bị hủy.</p><SourceTabs month={month} src="changes" live={live} /></div>
        <BookingChanges user={user} sp={sp} />
      </>
    );
  }
  const db = getDb();
  const props = await visibleProperties(db, user);
  // Bộ lọc: cơ sở, tên khách / mã đơn, khoảng ngày ở (có khoảng ngày thì xem qua nhiều tháng)
  const f = parseBookingFilter(sp, month, props.map((p) => p.id));
  const { ranged, filtered } = f;
  const rows = await filteredBookings(db, user, f);
  const showAmt = can(user, "viewBookingAmounts");
  const roomName = Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`])));
  const today = D.todayVN();
  const confirmed = rows.filter((b) => b.status !== "CANCELLED");
  const scope = filterScope(f);
  return (
    <>
      <div className="topbar"><h1>Đặt phòng</h1><MonthNav month={month} path="/bookings" /><SourceTabs month={month} src="db" live={live} /></div>
      {can(user, "admin") && <SyncMonth month={month} label={D.formatMonthVN(month)} accounts={await syncAccounts()} />}
      <div className="cards">
        <div className="stat"><span className="lbl">Đơn đã xác nhận</span><span className="v">{confirmed.length}</span><span className="s">{scope}</span></div>
        <div className="stat"><span className="lbl">Đơn đã hủy</span><span className="v">{rows.length - confirmed.length}</span></div>
        {showAmt && <div className="stat"><span className="lbl">Tổng thực nhận</span><span className="v">{vnd(confirmed.reduce((s, b) => s + b.netAmount, 0))}</span><span className="s">Sau khi trừ phí kênh bán, tính cả đơn kéo sang tháng khác</span></div>}
      </div>
      <section className="panel">
        <form className="filter-bar" action="/bookings" role="search" aria-label="Lọc đơn đặt phòng">
          {!ranged && <input type="hidden" name="month" value={month} />}
          <label className="field"><span>Cơ sở</span>
            <select name="prop" defaultValue={f.prop}>
              <option value="">Tất cả cơ sở</option>
              {props.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field grow"><span>Khách / mã đơn</span><input type="search" name="q" defaultValue={f.q} placeholder="vd: Nguyen, HMABC123" /></label>
          <label className="field"><span>Từ ngày</span><input type="date" name="from" defaultValue={f.from} /></label>
          <label className="field"><span>Đến ngày</span><input type="date" name="to" defaultValue={f.to} /></label>
          <div className="row">
            <button className="btn primary">Lọc</button>
            {filtered && <Link className="btn" href={`/bookings?month=${month}`}>Xóa lọc</Link>}
            {/* Thẻ a thường (không phải Link) để trình duyệt tải file thay vì điều hướng phía client */}
            <a className="btn" href={`/bookings/export?${filterQuery(f)}`} download>Xuất Excel</a>
          </div>
        </form>
        {filtered && (
          <p className="small muted" style={{ margin: "0 0 8px" }}>
            {rows.length} đơn{f.prop ? ` ở ${props.find((p) => p.id === f.prop)?.name}` : ""}{ranged ? `, ${scope.charAt(0).toLowerCase()}${scope.slice(1)}` : ` trong ${D.formatMonthVN(month).toLowerCase()}`}. Đơn tính là trong khoảng khi có ít nhất một đêm ở nằm trong đó.
          </p>
        )}
        <div className="tbl-wrap"><table>
          <thead><tr><th>Khách</th><th>Phòng</th><th>Kênh bán</th><th>Nhận – trả phòng</th>{showAmt && <><th className="n">Khách trả</th><th className="n">Phí kênh bán</th><th className="n">Thực nhận</th></>}<th>Trạng thái</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td><b>{b.guestName ?? "Khách"}</b><div className="small muted">{b.externalId ?? "Đơn ngoài OTA"}</div></td>
                <td>{roomName[b.roomId]}</td><td><span className="pill">{CHANNEL[b.channel] ?? b.channel}</span></td>
                <td className="num">{D.formatDateVN(b.checkIn)} – {D.formatDateVN(b.checkOut)}</td>
                {showAmt && <><td className="n">{vnd(b.grossAmount)}</td><td className="n muted">{vnd(b.commissionAmount)}</td><td className="n"><b>{vnd(b.netAmount)}</b></td></>}
                <td>{b.status === "CANCELLED" ? <span className="pill bad">Đã hủy</span> : <span className="pill ok">Đã xác nhận</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="muted small">{filtered ? "Không có đơn nào khớp bộ lọc." : "Chưa có đơn nào trong tháng."}</td></tr>}
          </tbody>
        </table></div>
      </section>
      {can(user, "createManualBooking") && (
        <section className="panel" style={{ marginTop: 24 }}>
          <header><div><h2>Tạo đơn ngoài OTA</h2><p>Khách chuyển khoản trực tiếp. Số tiền là doanh thu net, chia đều theo đêm.</p></div></header>
          <ActionForm action={manualBookingAction} submit="Lưu đơn" okText="Đã tạo đơn">
            <label className="field"><span>Phòng</span>
              <select name="roomId" id="roomId" required>{props.flatMap((p) => p.rooms.filter((r) => !r.closedOn).map((r) => <option key={r.id} value={r.id}>{p.name} · {r.name}</option>))}</select>
            </label>
            <label className="field"><span>Tên khách</span><input type="text" name="guestName" id="guestName" required /></label>
            <label className="field"><span>Ngày khách đặt</span><input type="date" name="bookedAt" id="bookedAt" defaultValue={today} /></label>
            <label className="field"><span>Nhận phòng</span><input type="date" name="checkIn" id="checkIn" defaultValue={today} required /></label>
            <label className="field"><span>Trả phòng</span><input type="date" name="checkOut" id="checkOut" defaultValue={D.addDays(today, 1)} required /></label>
            <label className="field"><span>Số tiền (VND)</span><input type="text" inputMode="numeric" name="amount" id="amount" required placeholder="1.500.000" /></label>
            <PhotoInput name="proof" label="Ảnh chuyển khoản (bắt buộc)" required />
          </ActionForm>
        </section>
      )}
    </>
  );
}

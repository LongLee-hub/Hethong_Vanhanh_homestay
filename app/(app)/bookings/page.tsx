import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { bookingsForMonth, monthParam, visibleProperties } from "@/lib/queries";
import { MonthNav, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { manualBookingAction } from "../actions";

const CHANNEL: Record<string, string> = { Direct: "Trực tiếp" };

export default async function Bookings({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewBookings")) return <NoAccess />;
  const month = monthParam((await searchParams).month);
  const db = getDb();
  const props = await visibleProperties(db, user);
  const rows = await bookingsForMonth(db, user, month);
  const showAmt = can(user, "viewBookingAmounts");
  const roomName = Object.fromEntries(props.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`])));
  const today = D.todayVN();
  const confirmed = rows.filter((b) => b.status !== "CANCELLED");
  return (
    <>
      <div className="topbar"><h1>Đặt phòng</h1><MonthNav month={month} path="/bookings" /></div>
      <div className="cards">
        <div className="stat"><span className="lbl">Đơn đã xác nhận</span><span className="v">{confirmed.length}</span><span className="s">Có đêm ở trong tháng</span></div>
        <div className="stat"><span className="lbl">Đơn đã hủy</span><span className="v">{rows.length - confirmed.length}</span></div>
        {showAmt && <div className="stat"><span className="lbl">Tổng thực nhận</span><span className="v">{vnd(confirmed.reduce((s, b) => s + b.netAmount, 0))}</span><span className="s">Sau khi trừ phí kênh bán, tính cả đơn kéo sang tháng khác</span></div>}
      </div>
      <section className="panel">
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
            {!rows.length && <tr><td colSpan={8} className="muted small">Chưa có đơn nào trong tháng.</td></tr>}
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

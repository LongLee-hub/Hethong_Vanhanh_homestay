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
  return (
    <>
      <div className="topbar"><h1>Đặt phòng</h1><MonthNav month={month} path="/bookings" /></div>
      <section className="panel">
        <div className="tbl-wrap"><table>
          <thead><tr><th>Khách</th><th>Phòng</th><th>Kênh</th><th>Nhận – Trả</th>{showAmt && <><th className="n">Gross</th><th className="n">Hoa hồng</th><th className="n">Net</th></>}<th>Trạng thái</th></tr></thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td><b>{b.guestName ?? "Khách"}</b><div className="small muted">{b.externalId ?? "Đơn ngoài OTA"}</div></td>
                <td>{roomName[b.roomId]}</td><td>{b.channel}</td>
                <td className="num">{D.formatDateVN(b.checkIn)} – {D.formatDateVN(b.checkOut)}</td>
                {showAmt && <><td className="n">{vnd(b.grossAmount)}</td><td className="n muted">{vnd(b.commissionAmount)}</td><td className="n"><b>{vnd(b.netAmount)}</b></td></>}
                <td>{b.status === "CANCELLED" ? <span className="pill bad">Đã hủy</span> : <span className="pill ok">Xác nhận</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="muted small">Chưa có đơn nào trong tháng.</td></tr>}
          </tbody>
        </table></div>
      </section>
      {can(user, "createManualBooking") && (
        <section className="panel" style={{ marginTop: 16 }}>
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

import Link from "next/link";
import { asc } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { investors } from "@/lib/db/schema";
import { accountsByInvestor } from "@/lib/dayladau/admin";
import { extraListingsOf } from "@/lib/dayladau/room-listings";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { visibleInvestors, visibleProperties } from "@/lib/queries";
import { vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import {
  closeRoomAction, createPropertyAction, renameRoomAction, reopenRoomAction, setRoomKpiAction,
  setPropertyAccountAction, setPropertyActiveAction, transferRoomAction, updatePropertyAction,
} from "./actions";
import { AddRoom } from "./add-room";

type Room = { id: string; name: string; dayladauRoomId: string | null; openedOn: string; closedOn: string | null; revenueKpiMonthly: number };

function roomStatus(r: Room, today: string) {
  if (r.closedOn && r.closedOn <= today) return <span className="pill">Đã đóng từ {D.formatDateVN(r.closedOn)}</span>;
  if (r.closedOn) return <span className="pill warn">Đóng từ {D.formatDateVN(r.closedOn)}</span>;
  if (r.openedOn > today) return <span className="pill fc">Mở từ {D.formatDateVN(r.openedOn)}</span>;
  return <span className="pill ok">Đang hoạt động</span>;
}

export default async function Properties({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const admin = can(user, "admin");
  const showMoney = can(user, "viewFee");
  const today = D.todayVN();
  const all = await visibleProperties(db, user);
  // Admin cần cả chủ đầu tư chưa có cơ sở nào để tạo cơ sở đầu tiên cho họ
  const invs = admin ? await db.select({ id: investors.id, name: investors.name }).from(investors).orderBy(asc(investors.name)) : await visibleInvestors(db, user);
  const invName = Object.fromEntries(invs.map((i) => [i.id, i.name]));
  // Tài khoản Dayladau chỉ Admin quản lý
  const accounts = admin ? await accountsByInvestor(db, invs.map((i) => i.id)) : [];
  const accLabel = Object.fromEntries(accounts.map((a) => [a.id, a.label]));
  const invId = invs.some((i) => i.id === sp.inv) ? sp.inv : null;
  const props = invId ? all.filter((p) => p.investorId === invId) : all;

  const rooms = props.flatMap((p) => p.rooms);
  const extra = await extraListingsOf(db, rooms.map((r) => r.id));
  const roomLabel = Object.fromEntries(all.flatMap((p) => p.rooms.map((r) => [r.id, `${p.name} · ${r.name}`])));
  const openRooms = rooms.filter((r) => !r.closedOn || r.closedOn > today).length;

  return (
    <>
      <div className="topbar">
        <h1>Cơ sở &amp; phòng</h1>
        <p className="sub">{admin ? "Thêm, sửa cơ sở và phòng của từng chủ đầu tư." : "Các cơ sở và phòng trong phạm vi bạn được xem."}</p>
        {invs.length > 1 && (
          <div className="chips" style={{ width: "100%" }}>
            <Link className="chip" aria-pressed={!invId} href="/properties">Tất cả</Link>
            {invs.map((i) => <Link key={i.id} className="chip" aria-pressed={i.id === invId} href={`/properties?inv=${i.id}`}>{i.name}</Link>)}
          </div>
        )}
      </div>

      <div className="cards">
        <div className="stat"><span className="lbl">Cơ sở đang hoạt động</span><span className="v">{props.filter((p) => p.active).length}</span><span className="s">Trên tổng {props.length} cơ sở</span></div>
        <div className="stat"><span className="lbl">Phòng đang mở</span><span className="v">{openRooms}</span><span className="s">{rooms.length - openRooms} phòng đã đóng</span></div>
        {showMoney && <div className="stat"><span className="lbl">Tổng vốn đầu tư</span><span className="v">{vnd(props.reduce((s, p) => s + p.investmentAmount, 0))}</span></div>}
      </div>

      {admin && invs.length > 0 && (
        <details className="panel fold">
          <summary><h2>Thêm cơ sở</h2><span className="small muted">Cơ sở mới cho một chủ đầu tư</span></summary>
          <ActionForm action={createPropertyAction} submit="Tạo cơ sở" okText="Đã tạo cơ sở">
            <label className="field"><span>Chủ đầu tư</span>
              <select name="investorId" id="new-investorId" defaultValue={invId ?? invs[0].id}>{invs.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
            </label>
            <label className="field"><span>Tên cơ sở</span><input type="text" name="name" id="new-name" required /></label>
            <label className="field"><span>Vốn đầu tư (VND)</span><input type="text" inputMode="numeric" name="investmentAmount" id="new-investmentAmount" placeholder="1.500.000.000" /></label>
            <label className="field"><span>Tháng bắt đầu đầu tư</span><input type="month" name="investmentStartMonth" id="new-investmentStartMonth" /></label>
            <label className="field"><span>Tài khoản Dayladau</span>
              <select name="dayladauAccountId" id="new-dayladauAccountId" defaultValue="">
                <option value="">— Chưa chọn (chỉ nhập đơn tay) —</option>
                {invs.map((i) => accounts.some((a) => a.investorId === i.id) && (
                  <optgroup key={i.id} label={i.name}>{accounts.filter((a) => a.investorId === i.id).map((a) => <option key={a.id} value={a.id}>{a.label} ({a.hostId})</option>)}</optgroup>
                ))}
              </select>
            </label>
          </ActionForm>
        </details>
      )}

      {!props.length && <div className="panel empty">{admin && !invs.length ? "Chưa có chủ đầu tư nào. Thêm chủ đầu tư ở mục Kết nối Dayladau." : "Chưa có cơ sở nào."}</div>}

      <div className="stack-lg">
        {props.map((p) => {
          // Chỉ chuyển phòng giữa các cơ sở đang hoạt động cùng chủ đầu tư
          const targets = all.filter((t) => t.investorId === p.investorId && t.id !== p.id && t.active);
          return (
            <section key={p.id} className="panel">
              <header>
                <div>
                  <div className="row"><h2>{p.name}</h2>{p.active ? <span className="pill ok">Đang hoạt động</span> : <span className="pill bad">Ngưng hoạt động</span>}</div>
                  <p>{[invName[p.investorId], p.address].filter(Boolean).join(" · ") || "Chưa có địa chỉ"}</p>
                </div>
              </header>

              <div className="facts">
                {showMoney && <div className="kv"><span>Vốn đầu tư</span><b>{vnd(p.investmentAmount)}</b></div>}
                <div className="kv"><span>Bắt đầu đầu tư</span><b>{p.investmentStartMonth ? D.formatMonthVN(p.investmentStartMonth) : "—"}</b></div>
                <div className="kv"><span>KPI kín phòng</span><b>{p.occupancyKpiPct}%</b></div>
                <div className="kv"><span>Chi phí biến đổi / đêm</span><b>{vnd(p.variableCostPerNight)}</b></div>
                <div className="kv"><span>Chi phí cố định / tháng</span><b>{vnd(p.fixedCostMonthly)}</b></div>
                {admin && <div className="kv"><span>Tài khoản Dayladau</span><b>{p.dayladauAccountId ? accLabel[p.dayladauAccountId] ?? "—" : "Chưa chọn"}</b></div>}
              </div>

              <h3 className="sub-title">Phòng ({p.rooms.length})</h3>
              <ul className="room-list">
                {p.rooms.map((r) => {
                  const closed = !!r.closedOn;
                  const head = (
                    <>
                      <b>{r.name}</b>
                      <span className="small muted">{r.dayladauRoomId ? `Listing ${r.dayladauRoomId}${extra.get(r.id)?.length ? ` + ${extra.get(r.id)!.length} listing cũ` : ""}` : "Chưa gắn listing"}</span>
                      {showMoney && <span className="small muted">KPI {r.revenueKpiMonthly ? `${vnd(r.revenueKpiMonthly)}/tháng` : "chưa đặt"}</span>}
                      <span className="spacer" />
                      {roomStatus(r, today)}
                    </>
                  );
                  return (
                    <li key={r.id}>
                      {!admin ? <div className="room-row">{head}</div> : (
                        <details>
                          <summary className="room-row">{head}<span className="chev" aria-hidden>›</span></summary>
                          <div className="room-actions">
                            <ActionForm action={renameRoomAction} submit="Đổi tên" okText="Đã đổi tên" className="row">
                              <input type="hidden" name="roomId" value={r.id} />
                              <input type="text" name="name" id={`name-${r.id}`} defaultValue={r.name} required aria-label="Tên phòng" />
                            </ActionForm>
                            <ActionForm action={setRoomKpiAction} submit="Lưu KPI" okText="Đã lưu KPI" className="row">
                              <input type="hidden" name="roomId" value={r.id} />
                              <input type="text" inputMode="numeric" name="revenueKpiMonthly" id={`kpi-${r.id}`} defaultValue={r.revenueKpiMonthly || ""} placeholder="11.000.000" aria-label="KPI doanh thu / tháng (VND)" />
                            </ActionForm>
                            {!closed && targets.length > 0 && (
                              <ActionForm action={transferRoomAction} submit="Chuyển cơ sở" okText="Đã chuyển" className="row">
                                <input type="hidden" name="roomId" value={r.id} />
                                <select name="targetPropertyId" id={`target-${r.id}`} aria-label="Cơ sở đích">{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                              </ActionForm>
                            )}
                            {closed ? (
                              <ActionForm action={reopenRoomAction} submit="Mở lại phòng" okText="Đã mở lại" className="row">
                                <input type="hidden" name="roomId" value={r.id} />
                              </ActionForm>
                            ) : (
                              <ActionForm action={closeRoomAction} submit="Đóng phòng" okText="Đã đóng phòng" className="row">
                                <input type="hidden" name="roomId" value={r.id} />
                                <label className="field"><span>Ngày đóng</span><input type="date" name="closedOn" id={`close-${r.id}`} defaultValue={today} required /></label>
                              </ActionForm>
                            )}
                            <p className="hint">Mở từ {D.formatDateVN(r.openedOn)}. Chỉ chuyển được phòng không còn đơn chưa trả phòng, sang cơ sở cùng chủ đầu tư. Cơ sở đích dùng tài khoản Dayladau khác thì listing của phòng bị bỏ gắn.</p>
                          </div>
                        </details>
                      )}
                    </li>
                  );
                })}
                {!p.rooms.length && <li className="room-row muted small">Cơ sở chưa có phòng.</li>}
              </ul>

              {admin && (
                <div className="stack" style={{ marginTop: 16 }}>
                  {p.active && (
                    <details className="fold sub">
                      <summary><b>Thêm phòng</b></summary>
                      <AddRoom
                        propertyId={p.id}
                        hasAccount={!!p.dayladauAccountId}
                        properties={all.filter((t) => t.investorId === p.investorId && t.active && t.dayladauAccountId === p.dayladauAccountId).map((t) => ({ id: t.id, name: t.name }))}
                        roomLabel={roomLabel}
                        today={today}
                      />
                    </details>
                  )}
                  <details className="fold sub">
                    <summary><b>Sửa thông tin cơ sở</b></summary>
                    <ActionForm action={updatePropertyAction} submit="Lưu thông tin" okText="Đã lưu">
                      <input type="hidden" name="propertyId" value={p.id} />
                      <label className="field full"><span>Tên cơ sở</span><input type="text" name="name" id={`p-name-${p.id}`} defaultValue={p.name} required /></label>
                      <label className="field full"><span>Địa chỉ</span><input type="text" name="address" id={`p-address-${p.id}`} defaultValue={p.address ?? ""} /></label>
                      <label className="field"><span>Vốn đầu tư (VND)</span><input type="text" inputMode="numeric" name="investmentAmount" id={`p-inv-${p.id}`} defaultValue={p.investmentAmount || ""} /></label>
                      <label className="field"><span>Tháng bắt đầu đầu tư</span><input type="month" name="investmentStartMonth" id={`p-start-${p.id}`} defaultValue={p.investmentStartMonth ?? ""} /></label>
                      <label className="field"><span>KPI kín phòng (%)</span><input type="number" min={0} max={100} name="occupancyKpiPct" id={`p-kpi-${p.id}`} defaultValue={p.occupancyKpiPct} /></label>
                      <label className="field"><span>Chi phí biến đổi / đêm</span><input type="text" inputMode="numeric" name="variableCostPerNight" id={`p-var-${p.id}`} defaultValue={p.variableCostPerNight || ""} /></label>
                      <label className="field"><span>Chi phí cố định / tháng</span><input type="text" inputMode="numeric" name="fixedCostMonthly" id={`p-fix-${p.id}`} defaultValue={p.fixedCostMonthly || ""} /></label>
                    </ActionForm>
                    <ActionForm action={setPropertyAccountAction} submit="Đổi tài khoản Dayladau" okText="Đã lưu" className="row">
                      <input type="hidden" name="propertyId" value={p.id} />
                      <select name="dayladauAccountId" id={`p-acc-${p.id}`} defaultValue={p.dayladauAccountId ?? ""} aria-label="Tài khoản Dayladau">
                        <option value="">— Chưa chọn (chỉ nhập đơn tay) —</option>
                        {accounts.filter((a) => a.investorId === p.investorId).map((a) => <option key={a.id} value={a.id}>{a.label} ({a.hostId})</option>)}
                      </select>
                    </ActionForm>
                    <p className="hint">Đổi tài khoản Dayladau sẽ bỏ gắn listing ở mọi phòng của cơ sở này; gắn lại ở trang Kết nối Dayladau.</p>
                    <ActionForm action={setPropertyActiveAction} submit={p.active ? "Ngưng hoạt động cơ sở" : "Mở lại cơ sở"} okText="Đã cập nhật" className={`row danger-zone ${p.active ? "" : "safe"}`}>
                      <input type="hidden" name="propertyId" value={p.id} /><input type="hidden" name="active" value={p.active ? "0" : "1"} />
                    </ActionForm>
                  </details>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}

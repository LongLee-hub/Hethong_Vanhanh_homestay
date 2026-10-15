import { redirect } from "next/navigation";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { investorForecast, paybackForInvestor } from "@/lib/services/settlement";
import { bookingsForMonth, openAlerts, visibleInvestors, visibleProperties } from "@/lib/queries";
import { sign, vnd } from "@/components/MonthNav";

export default async function Dashboard() {
  const user = await requireUser();
  if (user.role === "HOUSEKEEPER") redirect("/tasks");
  const db = getDb();
  const today = D.todayVN();
  const month = D.monthOf(today);
  // Các phần độc lập đọc DB song song để trang mở nhanh
  const [props, invRows, bks, al] = await Promise.all([visibleProperties(db, user), visibleInvestors(db, user), bookingsForMonth(db, user, month), openAlerts(db, user)]);
  const pids = props.map((p) => p.id);
  const showFee = can(user, "viewFee");
  // Quản lý cơ sở không xem phí/hoàn vốn nhưng vẫn xem doanh thu, chi phí của cơ sở được gán
  const invIds = [...new Set(props.map((p) => p.investorId))];
  const invNames = Object.fromEntries(invRows.map((i) => [i.id, i.name]));
  const forecasts = await Promise.all(
    invIds.map(async (id) => {
      const [f, pb] = await Promise.all([investorForecast(db, id, month, today), showFee ? paybackForInvestor(db, user, id) : null]);
      return { inv: { id, name: invNames[id] ?? "" }, f, pb };
    }),
  );
  const lines = forecasts.flatMap((x) => x.f.lines).filter((l) => pids.includes(l.propertyId));
  const sum = (k: "revenueForecast" | "revenuePast" | "costForecast" | "actualCost" | "soldPast" | "hourlyPast" | "bookedFuture") => lines.reduce((s, l) => s + l[k], 0);
  const ci = bks.filter((b) => b.status === "CONFIRMED" && b.checkIn === today);
  const co = bks.filter((b) => b.status === "CONFIRMED" && b.checkOut === today);

  // Số đêm có thể bán trong tháng của từng cơ sở, để vẽ thanh "đã ở / đã đặt / còn trống"
  const avail = Object.fromEntries(props.map((p) => [p.id, D.availableNights(p.rooms, D.firstDay(month), D.lastDay(month))]));
  const availAll = lines.reduce((s, l) => s + (avail[l.propertyId] ?? 0), 0);
  const pctOf = (n: number, total: number) => (total ? Math.min(100, Math.round((n / total) * 100)) : 0);

  // Phép tính ra con số chính. Vai trò xem được phí thì tính tới phần nhà đầu tư nhận; còn lại dừng ở lợi nhuận.
  const revenue = showFee ? forecasts.reduce((s, x) => s + x.f.revenueForecast, 0) : sum("revenueForecast");
  const cost = showFee ? forecasts.reduce((s, x) => s + x.f.costForecast, 0) : sum("costForecast");
  const fee = forecasts.reduce((s, x) => s + x.f.managementFee, 0);
  const headline = showFee ? forecasts.reduce((s, x) => s + x.f.investorNet, 0) : revenue - cost;
  const headlineLabel = !showFee ? "Lợi nhuận dự kiến tháng này" : user.role === "INVESTOR" ? "Tháng này bạn dự kiến nhận" : "Nhà đầu tư dự kiến nhận tháng này";
  const resultLabel = !showFee ? "Lợi nhuận" : user.role === "INVESTOR" ? "Bạn nhận" : "Nhà đầu tư nhận";

  return (
    <>
      <div className="topbar">
        <h1>Xin chào, {user.name}</h1>
        <p className="sub">Tình hình {D.formatMonthVN(month).toLowerCase()}, tính đến hôm nay {D.formatDateVN(today)}</p>
      </div>

      {!lines.length ? (
        <div className="panel empty">Chưa có cơ sở nào trong phạm vi bạn được xem.</div>
      ) : (
        <>
          <section className="hero">
            <div>
              <span className="cap">{headlineLabel}</span>
              <div className={`big ${sign(headline) === "neg" ? "neg" : ""}`}>{vnd(headline)}</div>
              <p className="note">Đây là số ước tính đến cuối tháng, gồm các đêm đã có khách và các đêm còn trống ước theo tháng trước. Số chính thức có ở mục Quyết toán sau khi khóa sổ.</p>
            </div>
            <dl className="calc">
              <div><dt>Doanh thu dự kiến</dt><dd>{vnd(revenue)}</dd></div>
              <div><dt>Chi phí dự kiến</dt><dd>− {vnd(cost)}</dd></div>
              {showFee && <div><dt>Phí quản lý LOCI</dt><dd>− {vnd(fee)}</dd></div>}
              <div className="sum"><dt>{resultLabel}</dt><dd className={sign(headline)}>{vnd(headline)}</dd></div>
            </dl>
          </section>

          <div className="cards">
            <div className="stat"><span className="lbl">Doanh thu đến hôm nay</span><span className="v">{vnd(sum("revenuePast"))}</span><span className="s">Tính cả đêm nay, lượt thuê giờ và phí hủy</span></div>
            <div className="stat"><span className="lbl">Đêm đã bán</span><span className="v">{sum("soldPast")}</span><span className="s">Trên tổng {availAll} đêm của tháng{sum("hourlyPast") ? `, thêm ${sum("hourlyPast")} lượt thuê giờ` : ""}</span></div>
            <div className="stat"><span className="lbl">Đêm đã có khách đặt</span><span className="v">{sum("bookedFuture")}</span><span className="s">Từ ngày mai đến cuối tháng</span></div>
            <div className="stat"><span className="lbl">Chi phí đã ghi nhận</span><span className="v">{vnd(sum("actualCost"))}</span><span className="s">Các khoản đã nhập trong tháng</span></div>
          </div>

          <h2 className="section-title">Từng cơ sở</h2>
          <div className="prop-list">
            {lines.map((l) => {
              const total = avail[l.propertyId] ?? 0;
              const free = Math.max(0, total - l.soldPast - l.bookedFuture);
              return (
                <article key={l.propertyId} className="prop">
                  <h3>{props.find((p) => p.id === l.propertyId)?.name}</h3>
                  <div><span className="lbl">Doanh thu dự kiến</span><div className="amt">{vnd(l.revenueForecast)}</div></div>
                  <div className="nights" role="img" aria-label={`${l.soldPast} đêm đã bán, ${l.bookedFuture} đêm đã đặt, ${free} đêm còn trống`}>
                    <i className="sold" style={{ width: `${pctOf(l.soldPast, total)}%` }} />
                    <i className="booked" style={{ width: `${pctOf(l.bookedFuture, total)}%` }} />
                  </div>
                  <div className="legend">
                    <span><i className="dot sold" /><b>{l.soldPast}</b> đêm đã bán</span>
                    <span><i className="dot booked" /><b>{l.bookedFuture}</b> đã đặt</span>
                    <span><i className="dot free" /><b>{free}</b> còn trống</span>
                  </div>
                  <div className="kv"><span>Doanh thu đến hôm nay</span><b>{vnd(l.revenuePast)}</b></div>
                  <div className="kv"><span>Giá trung bình mỗi đêm</span><b>{vnd(l.adrUsed)}</b></div>
                </article>
              );
            })}
          </div>
        </>
      )}

      <div className="grid g2" style={{ marginTop: 24 }}>
        {showFee && (
          <section className="panel">
            <header><div><h2>Hoàn vốn</h2><p>Tính trên các tháng đã khóa sổ</p></div></header>
            <div className="stack" style={{ gap: 24 }}>
              {forecasts.map(({ inv, pb }) => pb && (
                <div key={inv.id} className="stack" style={{ gap: 8 }}>
                  <div className="row"><b>{inv.name}</b><span className="spacer" /><span className="pill ok">{pctOf(pb.received, pb.investmentTotal)}%</span></div>
                  <div className="progress"><i style={{ width: `${pb.investmentTotal ? Math.min(100, Math.max(0, (pb.received / pb.investmentTotal) * 100)) : 0}%` }} /></div>
                  <div className="kv"><span>Đã nhận về</span><b>{vnd(pb.received)}</b></div>
                  <div className="kv"><span>Vốn đầu tư</span><b>{vnd(pb.investmentTotal)}</b></div>
                  <div className="small muted">{pb.monthsLeft === null ? "Chưa đủ dữ liệu để ước tính thời gian hoàn vốn" : pb.monthsLeft === 0 ? "Đã hoàn vốn" : `Dự kiến còn khoảng ${pb.monthsLeft} tháng nữa`}</div>
                </div>
              ))}
            </div>
          </section>
        )}
        <section className="panel">
          <header><h2>Hôm nay</h2></header>
          <div className="kv"><span>Khách nhận phòng</span><b>{ci.length}</b></div>
          {ci.length > 0 && <p className="small muted" style={{ margin: "4px 0 12px" }}>{ci.map((b) => b.guestName ?? "Khách").join(", ")}</p>}
          <div className="kv" style={{ marginTop: 8 }}><span>Khách trả phòng</span><b>{co.length}</b></div>
          {co.length > 0 && <p className="small muted" style={{ margin: "4px 0 0" }}>{co.map((b) => b.guestName ?? "Khách").join(", ")}</p>}
        </section>
        <section className="panel">
          <header><h2>Cần lưu ý</h2>{al.length > 0 && <span className="pill warn">{al.length}</span>}</header>
          {al.length ? al.map((a) => <div key={a.id} className={`banner ${a.type === "TASK_OVERDUE" ? "bad" : ""}`}>{a.message}</div>) : <p className="small muted" style={{ margin: 0 }}>Không có gì cần lưu ý.</p>}
        </section>
      </div>
    </>
  );
}

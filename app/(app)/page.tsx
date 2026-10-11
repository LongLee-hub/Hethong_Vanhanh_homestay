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
  const props = await visibleProperties(db, user);
  const pids = props.map((p) => p.id);
  const showFee = can(user, "viewFee");
  // Quản lý cơ sở không xem phí/hoàn vốn nhưng vẫn xem doanh thu, chi phí của cơ sở được gán
  const invIds = [...new Set(props.map((p) => p.investorId))];
  const invNames = Object.fromEntries((await visibleInvestors(db, user)).map((i) => [i.id, i.name]));
  const forecasts = [];
  for (const id of invIds) {
    forecasts.push({
      inv: { id, name: invNames[id] ?? "" },
      f: await investorForecast(db, id, month, today),
      pb: showFee ? await paybackForInvestor(db, user, id) : null,
    });
  }
  const lines = forecasts.flatMap((x) => x.f.lines).filter((l) => pids.includes(l.propertyId));
  const sum = (k: "revenueForecast" | "revenuePast" | "costForecast" | "actualCost") => lines.reduce((s, l) => s + l[k], 0);
  const bks = await bookingsForMonth(db, user, month);
  const ci = bks.filter((b) => b.status === "CONFIRMED" && b.checkIn === today);
  const co = bks.filter((b) => b.status === "CONFIRMED" && b.checkOut === today);
  const al = await openAlerts(db, user);

  return (
    <>
      <div className="topbar"><h1>Tổng quan · {D.formatMonthVN(month)}</h1></div>
      <div className="cards">
        <div className="stat"><span className="lbl">Doanh thu thực tế</span><span className="v">{vnd(sum("revenuePast"))}</span><span className="s">Các đêm đến hết hôm qua</span></div>
        <div className="stat fc"><span className="lbl">Doanh thu dự kiến</span><span className="v">{vnd(sum("revenueForecast"))}</span></div>
        <div className="stat"><span className="lbl">Chi phí đã nhập</span><span className="v">{vnd(sum("actualCost"))}</span></div>
        <div className="stat fc"><span className="lbl">Lợi nhuận dự kiến</span><span className={`v ${sign(sum("revenueForecast") - sum("costForecast"))}`}>{vnd(sum("revenueForecast") - sum("costForecast"))}</span></div>
        {showFee && <div className="stat fc"><span className="lbl">Phí quản lý dự kiến</span><span className="v">{vnd(forecasts.reduce((s, x) => s + x.f.managementFee, 0))}</span></div>}
        {showFee && <div className="stat fc"><span className="lbl">NĐT nhận dự kiến</span><span className="v">{vnd(forecasts.reduce((s, x) => s + x.f.investorNet, 0))}</span></div>}
      </div>
      <div className="grid g2">
        <section className="panel">
          <header><h2>Theo cơ sở</h2></header>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Cơ sở</th><th className="n">Đêm đã bán</th><th className="n">Đã đặt tới cuối tháng</th><th className="n">ADR</th><th className="n">DT dự kiến</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.propertyId}><td>{props.find((p) => p.id === l.propertyId)?.name}</td><td className="n">{l.soldPast}</td><td className="n">{l.bookedFuture}</td><td className="n">{vnd(l.adrUsed)}</td><td className="n">{vnd(l.revenueForecast)}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
        <section className="panel">
          <header><h2>Hôm nay · {D.formatDateVN(today)}</h2></header>
          <p className="small"><b>Check-in ({ci.length}):</b> {ci.map((b) => b.guestName).join(", ") || "không có"}</p>
          <p className="small"><b>Check-out ({co.length}):</b> {co.map((b) => b.guestName).join(", ") || "không có"}</p>
        </section>
        <section className="panel">
          <header><h2>Cảnh báo</h2></header>
          {al.length ? al.map((a) => <div key={a.id} className={`banner ${a.type === "TASK_OVERDUE" ? "bad" : ""}`}>{a.message}</div>) : <p className="small muted">Không có cảnh báo.</p>}
        </section>
        {showFee && (
          <section className="panel">
            <header><h2>Hoàn vốn</h2></header>
            {forecasts.map(({ inv, pb }) => pb && (
              <div key={inv.id} className="stack" style={{ gap: 6, marginBottom: 12 }}>
                <div className="row"><b>{inv.name}</b><span className="spacer" /><span className="num small">{vnd(pb.received)} / {vnd(pb.investmentTotal)}</span></div>
                <div className="progress"><i style={{ width: `${pb.investmentTotal ? Math.min(100, Math.max(0, (pb.received / pb.investmentTotal) * 100)) : 0}%` }} /></div>
                <div className="small muted">{pb.monthsLeft === null ? "Chưa xác định thời gian hoàn vốn" : pb.monthsLeft === 0 ? "Đã hoàn vốn" : `Dự kiến còn ${pb.monthsLeft} tháng`}</div>
              </div>
            ))}
          </section>
        )}
      </div>
    </>
  );
}

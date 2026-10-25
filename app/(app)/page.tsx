import Link from "next/link";
import { redirect } from "next/navigation";
import { inArray } from "drizzle-orm";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { dayladauAccounts } from "@/lib/db/schema";
import { can } from "@/lib/auth/access";
import { requireUser } from "@/lib/server";
import { investorForecast, paybackForInvestor } from "@/lib/services/settlement";
import { targetsForMonth } from "@/lib/services/targets";
import { bookingsForMonth, openAlerts, visibleInvestors, visibleProperties } from "@/lib/queries";
import { sign, vnd } from "@/components/MonthNav";

/** Số tiền gọn cho bảng và thanh KPI: 925,3 tr, 1,15 tỷ. */
function short(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? "−" : "";
  const dec = (x: number, d: number) => x.toFixed(d).replace(/\.?0+$/, "").replace(".", ",");
  if (a >= 1e9) return `${s}${dec(a / 1e9, 2)} tỷ`;
  if (a >= 1e6) return `${s}${dec(a / 1e6, 1)} tr`;
  if (a >= 1e3) return `${s}${Math.round(a / 1e3)}k`;
  return `${s}${a}`;
}
const pctTxt = (n: number) => `${String(n).replace(".", ",")}%`;
const STATUS_TXT = { ok: "Kịp tiến độ", warn: "Chậm nhẹ", bad: "Chậm tiến độ", none: "" } as const;
const RATIO_TXT = { ok: "Đạt", warn: "Gần đạt", bad: "Dưới mục tiêu", none: "" } as const;

function KpiBar({ fill, mark, status, label }: { fill: number; mark: number | null; status: D.KpiStatus; label: string }) {
  const clamp = (x: number) => Math.max(0, Math.min(100, x));
  return (
    <div className="kbar" role="img" aria-label={label}>
      <i className={`fill ${status}`} style={{ width: `${clamp(fill)}%` }} />
      {mark !== null && <i className="mark" style={{ left: `${clamp(mark)}%` }} />}
    </div>
  );
}

const fmtTime = (d: Date) =>
  new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" }).format(d);

export default async function Dashboard() {
  const user = await requireUser();
  if (user.role === "HOUSEKEEPER") redirect("/tasks");
  const db = getDb();
  const today = D.todayVN();
  const month = D.monthOf(today);
  const from = D.firstDay(month);
  const to = D.lastDay(month);
  // Các phần độc lập đọc DB song song để trang mở nhanh
  const [props, invRows, bks, al, targets] = await Promise.all([
    visibleProperties(db, user),
    visibleInvestors(db, user),
    bookingsForMonth(db, user, month),
    openAlerts(db, user),
    targetsForMonth(db, user, month),
  ]);
  const pids = props.map((p) => p.id);
  const showFee = can(user, "viewFee");
  const isAdmin = can(user, "admin");
  const mine = user.role === "INVESTOR";
  const invIds = [...new Set(props.map((p) => p.investorId))];
  const invNames = Object.fromEntries(invRows.map((i) => [i.id, i.name]));
  const forecasts = await Promise.all(
    invIds.map(async (id) => {
      const [f, pb] = await Promise.all([investorForecast(db, id, month, today), showFee ? paybackForInvestor(db, user, id) : null]);
      return { inv: { id, name: invNames[id] ?? "" }, f, pb };
    }),
  );

  // Lần đồng bộ Dayladau cũ nhất trong các tài khoản của cơ sở đang xem: số liệu chỉ mới bằng tài khoản chậm nhất
  const accIds = [...new Set(props.map((p) => p.dayladauAccountId).filter((x): x is string => !!x))];
  const accs = accIds.length
    ? await db.select({ at: dayladauAccounts.lastSyncedAt, status: dayladauAccounts.lastSyncStatus }).from(dayladauAccounts).where(inArray(dayladauAccounts.id, accIds))
    : [];
  const syncFailed = accs.some((a) => a.status === "FAILED");
  const syncAt = accs.reduce<Date | null>((m, a) => (a.at && (!m || a.at < m) ? a.at : m), null);
  const syncStale = !syncAt || Date.now() - syncAt.getTime() > 6 * 3600 * 1000;

  // ---- Từng cơ sở: thực tế đến hôm nay so với chỉ tiêu ----
  const rows = forecasts.flatMap(({ inv, f }) =>
    f.lines
      .filter((l) => pids.includes(l.propertyId))
      .map((l) => {
        const p = props.find((x) => x.id === l.propertyId)!;
        const actual = { revenue: l.revenuePast, soldNights: l.soldPast, availableNights: D.availableNights(p.rooms, from, today < to ? today : to) };
        const monthAvail = D.availableNights(p.rooms, from, to);
        const target = targets[l.propertyId] ?? null;
        return { inv, l, name: p.name, actual, monthAvail, target, k: D.kpiProgress({ month, today, actual, target }), profit: l.revenuePast - l.actualCost };
      }),
  );
  const rollup = (rs: typeof rows) => {
    const actual = rs.reduce((s, r) => ({ revenue: s.revenue + r.actual.revenue, soldNights: s.soldNights + r.actual.soldNights, availableNights: s.availableNights + r.actual.availableNights }), { revenue: 0, soldNights: 0, availableNights: 0 });
    const target = D.aggregateTargets(rs.map((r) => ({ target: r.target, monthAvailableNights: r.monthAvail })));
    return { actual, target, k: D.kpiProgress({ month, today, actual, target }), profit: rs.reduce((s, r) => s + r.profit, 0) };
  };
  const total = rollup(rows);
  const byInv = forecasts.map(({ inv }) => ({ inv, rows: rows.filter((r) => r.inv.id === inv.id) })).filter((x) => x.rows.length).map((x) => ({ ...x, ...rollup(x.rows) }));

  // ---- Lãi lỗ: thực tế đến hôm nay là số chính; dự kiến cả tháng là số phụ ----
  const sumA = (k: "revenue" | "cost" | "vat" | "fee" | "pit" | "investorNet") => forecasts.reduce((s, x) => s + x.f.actual[k], 0);
  const headline = showFee ? sumA("investorNet") : total.actual.revenue - rows.reduce((s, r) => s + r.l.actualCost, 0);
  const forecastNet = showFee ? forecasts.reduce((s, x) => s + x.f.investorNet, 0) : rows.reduce((s, r) => s + r.l.revenueForecast - r.l.costForecast, 0);
  const who = !showFee ? "" : mine ? " của bạn" : " của nhà đầu tư";
  const ci = bks.filter((b) => b.status === "CONFIRMED" && b.checkIn === today);
  const co = bks.filter((b) => b.status === "CONFIRMED" && b.checkOut === today);
  const k = total.k;
  const hasTarget = !!total.target;
  const pctOf = (n: number, t: number) => (t ? Math.min(100, Math.max(0, (n / t) * 100)) : 0);
  // Thang của thanh giá TB: mục tiêu nằm ở 80% chiều dài để còn chỗ cho phần vượt
  const adrScale = Math.max(k.adr.target ?? 0, k.adr.actual) * 1.25 || 1;

  return (
    <>
      <div className="topbar">
        <h1>Xin chào, {user.name}</h1>
        <span className={`pill ${syncFailed ? "bad" : syncStale ? "warn" : "ok"}`} title="Lần đồng bộ đặt phòng từ Dayladau cũ nhất trong các tài khoản">
          {syncFailed ? "Đồng bộ Dayladau lỗi" : syncAt ? `Đồng bộ Dayladau ${fmtTime(syncAt)}` : "Chưa đồng bộ Dayladau"}
        </span>
        <p className="sub">{D.formatMonthVN(month)}, đã qua {k.daysElapsed}/{k.daysInMonth} ngày. Số liệu tính đến hết hôm nay {D.formatDateVN(today)}.</p>
      </div>

      {!rows.length ? (
        <div className="panel empty">Chưa có cơ sở nào trong phạm vi bạn được xem.</div>
      ) : (
        <>
          <section className="hero">
            <div>
              <span className="cap">Lợi nhuận{who} đến hôm nay</span>
              <div className={`big ${sign(headline) === "neg" ? "neg" : ""}`}>{vnd(headline)}</div>
              <p className="forecast">Dự kiến cả tháng <b className={sign(forecastNet) === "neg" ? "neg" : ""}>{vnd(forecastNet)}</b></p>
              <p className="note">Số dự kiến lấy doanh thu bình quân mỗi ngày nhân số ngày của tháng; chi phí dự kiến không thấp hơn số đã chi. Số chính thức có ở mục Quyết toán sau khi khóa sổ.{showFee ? ` Tiền phòng về thẳng tài khoản${who}, LOCI chỉ thu phí quản lý.` : ""}</p>
            </div>
            <dl className="calc">
              <div><dt>Doanh thu đến hôm nay</dt><dd>{vnd(showFee ? sumA("revenue") : total.actual.revenue)}</dd></div>
              <div><dt>Chi phí đã ghi nhận</dt><dd>− {vnd(showFee ? sumA("cost") : rows.reduce((s, r) => s + r.l.actualCost, 0))}</dd></div>
              {showFee && sumA("vat") > 0 && <div><dt>Thuế GTGT</dt><dd>− {vnd(sumA("vat"))}</dd></div>}
              {showFee && <div><dt>Phí quản lý{mine ? " bạn chuyển" : ""} cho LOCI</dt><dd>− {vnd(sumA("fee"))}</dd></div>}
              {showFee && sumA("pit") > 0 && <div><dt>Thuế TNCN</dt><dd>− {vnd(sumA("pit"))}</dd></div>}
              <div className="sum"><dt>Lợi nhuận{who}</dt><dd className={sign(headline)}>{vnd(headline)}</dd></div>
            </dl>
          </section>

          <section className="panel kpis">
            <header>
              <div><h2>KPI tháng</h2><p>{hasTarget ? "Vạch đen là mức cần đạt. Doanh thu so theo số ngày đã qua; công suất và giá trung bình so thẳng với mục tiêu." : "Chưa có chỉ tiêu cho tháng này, đang hiện số thực tế."}</p></div>
              {isAdmin && <Link className="btn sm" href={`/targets?month=${month}`}>{hasTarget ? "Sửa chỉ tiêu" : "Đặt chỉ tiêu"}</Link>}
            </header>

            <div className="kpi">
              <div className="kpi-head"><span>Doanh thu</span><span><b>{short(k.revenue.actual)}</b>{k.revenue.target ? <> / {short(k.revenue.target)} ({pctTxt(k.revenue.pct!)})</> : null}</span></div>
              <KpiBar fill={k.revenue.target ? pctOf(k.revenue.actual, k.revenue.target) : 0} mark={k.revenue.pacePct} status={k.revenue.status}
                label={k.revenue.target ? `Doanh thu ${pctTxt(k.revenue.pct!)} mục tiêu, cần ${pctTxt(k.revenue.pacePct!)} theo số ngày` : "Chưa có chỉ tiêu doanh thu"} />
              <p className="kpi-note">Dự kiến cuối tháng {short(k.revenue.forecast)}{k.revenue.forecastPct !== null ? ` (${pctTxt(k.revenue.forecastPct)} mục tiêu)` : ""}{k.revenue.status !== "none" && <span className={`pill ${k.revenue.status}`}>{STATUS_TXT[k.revenue.status]}</span>}</p>
            </div>

            <div className="kpi">
              <div className="kpi-head"><span>Công suất phòng</span><span><b>{pctTxt(k.occupancy.actual)}</b>{k.occupancy.target ? <> / mục tiêu {pctTxt(k.occupancy.target)}</> : null}</span></div>
              <KpiBar fill={k.occupancy.actual} mark={k.occupancy.target} status={k.occupancy.status}
                label={`Công suất ${pctTxt(k.occupancy.actual)}${k.occupancy.target ? `, mục tiêu ${pctTxt(k.occupancy.target)}` : ""}`} />
              <p className="kpi-note">{total.actual.soldNights} đêm bán / {total.actual.availableNights} đêm mở bán đến hôm nay{k.occupancy.status !== "none" && <span className={`pill ${k.occupancy.status}`}>{RATIO_TXT[k.occupancy.status]}</span>}</p>
            </div>

            <div className="kpi">
              <div className="kpi-head"><span>Giá trung bình / đêm</span><span><b>{vnd(k.adr.actual)}</b>{k.adr.target ? <> / mục tiêu {vnd(k.adr.target)}</> : null}</span></div>
              <KpiBar fill={(k.adr.actual / adrScale) * 100} mark={k.adr.target ? (k.adr.target / adrScale) * 100 : null} status={k.adr.status}
                label={`Giá trung bình ${vnd(k.adr.actual)}${k.adr.target ? `, mục tiêu ${vnd(k.adr.target)}` : ""}`} />
              <p className="kpi-note">Tính gộp cả doanh thu thuê giờ{k.adr.pct !== null ? `, bằng ${pctTxt(k.adr.pct)} mục tiêu` : ""}{k.adr.status !== "none" && <span className={`pill ${k.adr.status}`}>{RATIO_TXT[k.adr.status]}</span>}</p>
            </div>
          </section>

          <section className="panel">
            <header><div><h2>{isAdmin ? "KPI theo nhà đầu tư" : "Từng cơ sở"}</h2><p>Phần trăm so với mục tiêu. Xanh: kịp tiến độ, vàng: chậm dưới 10%, đỏ: chậm từ 10% trở lên.</p></div></header>
            <div className="tbl-wrap">
              <table className="kpi-table">
                <thead>
                  <tr><th>{isAdmin ? "Nhà đầu tư / cơ sở" : "Cơ sở"}</th><th className="n">Doanh thu</th><th className="n">Công suất</th><th className="n">Giá TB</th><th className="n">Lãi trước phí</th></tr>
                </thead>
                <tbody>
                  {(isAdmin ? byInv : [{ inv: null, rows, ...total }]).flatMap((g) => [
                    ...(g.inv ? [<KpiRow key={g.inv.id} name={g.inv.name} sub={`${g.rows.length} cơ sở`} k={g.k} profit={g.profit} group />] : []),
                    ...g.rows.map((r) => <KpiRow key={r.l.propertyId} name={r.name} k={r.k} profit={r.profit} indent={!!g.inv} />),
                  ])}
                </tbody>
              </table>
            </div>
            {showFee && <p className="small muted" style={{ margin: "12px 0 0" }}>Phí quản lý tính trên tổng lợi nhuận các cơ sở của mỗi nhà đầu tư, nên cơ sở lỗ được bù bởi cơ sở lãi.</p>}
          </section>
        </>
      )}

      <div className="grid g2" style={{ marginTop: 24 }}>
        {showFee && (
          <section className="panel">
            <header><div><h2>Hoàn vốn</h2><p>Tính trên các tháng đã khóa sổ</p></div></header>
            <div className="stack" style={{ gap: 24 }}>
              {forecasts.map(({ inv, pb }) => pb && (
                <div key={inv.id} className="stack" style={{ gap: 8 }}>
                  <div className="row"><b>{inv.name}</b><span className="spacer" /><span className="pill ok">{Math.round(pctOf(pb.received, pb.investmentTotal))}%</span></div>
                  <div className="progress"><i style={{ width: `${pctOf(pb.received, pb.investmentTotal)}%` }} /></div>
                  <div className="kv"><span>Lợi nhuận đã thu về</span><b>{vnd(pb.received)}</b></div>
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

function KpiRow({ name, sub, k, profit, group, indent }: { name: string; sub?: string; k: D.KpiProgress; profit: number; group?: boolean; indent?: boolean }) {
  const cell = (it: D.KpiItem, actualTxt: string) => (
    <td className={`n st-${it.status}`}>
      {it.pct !== null ? pctTxt(it.pct) : "—"}
      <span className="s">{actualTxt}</span>
    </td>
  );
  return (
    <tr className={group ? "grp" : indent ? "sub" : ""}>
      <td>{name}{sub && <span className="s">{sub}</span>}</td>
      {cell(k.revenue, `${short(k.revenue.actual)}${k.revenue.target ? ` / ${short(k.revenue.target)}` : ""}`)}
      {cell(k.occupancy, `${pctTxt(k.occupancy.actual)}${k.occupancy.target ? ` / ${pctTxt(k.occupancy.target)}` : ""}`)}
      {cell(k.adr, `${short(k.adr.actual)}${k.adr.target ? ` / ${short(k.adr.target)}` : ""}`)}
      <td className={`n ${sign(profit)}`}>{short(profit)}</td>
    </tr>
  );
}

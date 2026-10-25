import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { adjustmentDetails, commonCostBasis, getSettlement, paybackForInvestor } from "@/lib/services/settlement";
import { visibleInvestors, visibleProperties, monthParam } from "@/lib/queries";
import { MonthNav, sign, vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { lockAction, unlockAction } from "../actions";

export default async function Settlements({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const sp = await searchParams;
  const user = await requireUser();
  if (!can(user, "viewFee")) return <NoAccess />;
  const db = getDb();
  const month = monthParam(sp.month);
  const invs = await visibleInvestors(db, user);
  if (!invs.length) return <div className="empty">Không có nhà đầu tư nào trong phạm vi được xem.</div>;
  const invId = invs.some((i) => i.id === sp.inv) ? sp.inv : invs[0].id;
  const s = await getSettlement(db, user, invId, month);
  const [pb, props, adjs, basis] = await Promise.all([
    paybackForInvestor(db, user, invId),
    visibleProperties(db, user),
    adjustmentDetails(db, user, invId, month),
    commonCostBasis(db, month, s.status === "LOCKED"),
  ]);
  const names = Object.fromEntries(props.map((p) => [p.id, p.name]));
  const pct = (l: (typeof s.lines)[number]) => (l.availableNights ? Math.round((l.soldNights / l.availableNights) * 1000) / 10 : 0);
  const mine = user.role === "INVESTOR";
  // Tiền phòng về thẳng tài khoản NĐT; LOCI không chuyển tiền cho NĐT mà NĐT chuyển phí quản lý cho LOCI.
  const who = mine ? "Lợi nhuận của bạn" : "Lợi nhuận của nhà đầu tư";
  const locked = s.status === "LOCKED";
  const monthLow = D.formatMonthVN(month).toLowerCase();

  // Lãi/lỗ bù trừ giữa các cơ sở trước khi tính phí
  const losers = s.lines.filter((l) => l.profit < 0);
  const offset = s.lines.length > 1 && losers.length > 0 && losers.length < s.lines.length;
  const loss = s.totalProfit <= 0;
  // CĐT đặc biệt (vd Uxistay): thuế GTGT trừ trước phí quản lý, thuế TNCN trừ sau phí
  const taxed = s.vatPct > 0 || s.pitPct > 0;

  // Công thức chi phí chung: tổng toàn hệ thống ÷ số phòng × số phòng của NĐT
  const myRooms = s.lines.reduce((t, l) => t + l.roomCount, 0);
  const perRoomTxt = vnd(Math.round(basis.perRoom));
  const formulaExact = Math.abs(Math.round(basis.perRoom * myRooms) - s.totalCommonCost) <= 1;
  const pbPct = pb.investmentTotal ? Math.min(100, Math.max(0, Math.round((pb.received / pb.investmentTotal) * 100))) : 0;
  return (
    <>
      <div className="topbar">
        <h1>Quyết toán</h1>
        <MonthNav month={month} path="/settlements" extra={`&inv=${invId}`} />
        {invs.length > 1 && <div className="chips" style={{ width: "100%" }}>{invs.map((i) => <Link key={i.id} className="chip" aria-pressed={i.id === invId} href={`/settlements?month=${month}&inv=${i.id}`}>{i.name}</Link>)}</div>}
      </div>
      {!locked && s.commonProvisional && <div className="banner">Chi phí chung đang tạm tính theo tháng trước, sẽ được cập nhật khi kê khai xong.</div>}
      <section className="hero">
        <div>
          <div className="row"><span className="cap">{who} {monthLow}</span>{locked ? <span className="pill ok">Đã khóa sổ</span> : <span className="pill fc">Tạm tính</span>}</div>
          <div className={`big ${sign(s.investorNet) === "neg" ? "neg" : ""}`}>{vnd(s.investorNet)}</div>
          <p className="note">{locked ? "Số liệu đã chốt, không thay đổi nữa." : "Số liệu tính đến lúc này và còn có thể thay đổi cho đến khi khóa sổ."}</p>
        </div>
        <dl className="calc">
          <div><dt>Doanh thu (đã trừ hoa hồng OTA)</dt><dd>{vnd(s.totalRevenue)}</dd></div>
          <div><dt>Chi phí của cơ sở</dt><dd>− {vnd(s.totalDirectCost)}</dd></div>
          <div><dt>Chi phí chung được chia</dt><dd>− {vnd(s.totalCommonCost)}</dd></div>
          {s.vatPct > 0 && <div><dt>Thuế VAT chủ nhà trả ({s.vatPct}% doanh thu)</dt><dd>− {vnd(s.vat)}</dd></div>}
          <div><dt>Lợi nhuận thực tính{s.vatPct > 0 ? " (sau VAT)" : " (chủ nhà không trả VAT)"}</dt><dd className={sign(s.totalProfit)}>{vnd(s.totalProfit)}</dd></div>
          <div><dt>Phí Host LOCI ({s.feePct}% lợi nhuận thực tính)</dt><dd>{loss ? "0 ₫" : `− ${vnd(s.managementFee)}`}</dd></div>
          {s.pitPct > 0 && <div><dt>Thuế TNCN ({s.pitPct}% lợi nhuận sau phí)</dt><dd>{s.pit ? `− ${vnd(s.pit)}` : "0 ₫"}</dd></div>}
          <div className="sum"><dt>{who}</dt><dd className={sign(s.investorNet)}>{vnd(s.investorNet)}</dd></div>
        </dl>
      </section>

      <section className="panel fee-due">
        <div className="fee-due-main">
          <span className="cap">Phí quản lý {mine ? "bạn cần chuyển" : "nhà đầu tư cần chuyển"} cho LOCI</span>
          <div className="fee-due-amt">{loss ? "0 ₫" : vnd(s.managementFee)}</div>
          <p className="small muted">
            {loss
              ? `${D.formatMonthVN(month)} lỗ nên không phát sinh phí quản lý.`
              : locked
                ? "Số chính thức sau khi khóa sổ."
                : "Số tạm tính. Số chính thức có sau khi khóa sổ."}
          </p>
        </div>
        <p className="small muted fee-due-note">
          Tiền phòng từ các kênh bán về thẳng tài khoản của {mine ? "bạn" : "nhà đầu tư"}, chi phí cũng do {mine ? "bạn" : "nhà đầu tư"} trả trực tiếp. Mỗi tháng {mine ? "bạn" : "nhà đầu tư"} chỉ chuyển khoản phí quản lý cho LOCI.
        </p>
      </section>

      <section className="panel">
        <header><div><h2>Chi tiết từng cơ sở</h2><p>Lợi nhuận = doanh thu + điều chỉnh − chi phí của cơ sở − chi phí chung</p></div></header>
        <div className="tbl-wrap"><table>
          <thead><tr><th>Cơ sở</th><th className="n">Số phòng</th><th className="n">Tỷ lệ kín phòng</th><th className="n">Doanh thu</th><th className="n">Điều chỉnh</th><th className="n">Chi phí cơ sở</th><th className="n">Chi phí chung</th><th className="n">Lợi nhuận</th></tr></thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.propertyId}><td><b>{names[l.propertyId] ?? l.propertyId}</b></td><td className="n">{l.roomCount}</td><td className="n">{pct(l)}%</td><td className="n">{vnd(l.nightRevenue)}</td><td className="n">{l.adjustments ? vnd(l.adjustments) : "—"}</td><td className="n">{vnd(l.directCost)}</td><td className="n">{vnd(l.commonCostAlloc)}</td><td className={`n ${sign(l.profit)}`}><b>{vnd(l.profit)}</b></td></tr>
            ))}
            <tr className="total"><td colSpan={7}>Tổng lợi nhuận{taxed ? " (chưa trừ thuế)" : ""}</td><td className={`n ${sign(s.operatingProfit)}`}>{vnd(s.operatingProfit)}</td></tr>
          </tbody>
        </table></div>
        <div className="explain">
          {offset && (
            <p>
              Lỗ ở {losers.map((l) => `${names[l.propertyId] ?? l.propertyId} (${vnd(l.profit)})`).join(", ")} đã được bù vào lãi của các cơ sở còn lại.
              Phí quản lý tính trên tổng lợi nhuận {vnd(s.totalProfit)}, không tính riêng trên cơ sở có lãi.
            </p>
          )}
          {loss && <p>{s.vatPct > 0 ? "Lợi nhuận sau thuế VAT" : "Tổng các cơ sở"} {s.totalProfit < 0 ? "lỗ" : "hòa vốn"} trong tháng, nên LOCI không thu phí quản lý tháng này.</p>}
          {taxed && (
            <p>
              {s.vatPct > 0
                ? <>Chủ nhà trả VAT: {s.vatPct}% × doanh thu {vnd(s.totalRevenue)} = {vnd(s.vat)}. Lợi nhuận thực tính = {vnd(s.operatingProfit)} − {vnd(s.vat)} = {vnd(s.totalProfit)}, Phí Host = {s.feePct}% × {vnd(s.totalProfit)}.</>
                : <>Chủ nhà không trả VAT: Phí Host = {s.feePct}% × lợi nhuận {vnd(s.totalProfit)}.</>}
              {s.pitPct > 0 && <> TNCN {s.pitPct}% × lợi nhuận sau khi trừ hết chi phí, thuế GTGT và phí quản lý ({vnd(s.totalProfit - s.managementFee)}) = {vnd(s.pit)}.</>}
            </p>
          )}
          <p>
            Chi phí chung: {basis.provisional ? `tạm tính theo ${D.formatMonthVN(basis.basisMonth).toLowerCase()}, ` : ""}
            tổng {vnd(basis.total)} chi phí chung (Unix) ÷ {basis.rooms} phòng Unix = {perRoomTxt}/phòng × {myRooms} phòng của {mine ? "bạn" : "nhà đầu tư"}
            {" "}= <b>{vnd(s.totalCommonCost)}</b>{formulaExact ? "." : " (chênh vài đồng do làm tròn)."}
          </p>
          <p>Doanh thu tính theo đêm khách ở trong tháng, nên sẽ khác số tiền OTA chuyển về tài khoản trong tháng. Mỗi kênh trả tiền theo lịch riêng.</p>
        </div>
      </section>
      {adjs.length > 0 && (
        <section className="panel" style={{ marginTop: 24 }}>
          <header><div><h2>Điều chỉnh từ tháng đã khóa sổ</h2><p>Đơn thay đổi sau khi tháng gốc đã chốt được ghi vào {monthLow}, không sửa lại tháng cũ.</p></div></header>
          <div className="tbl-wrap"><table>
            <thead><tr><th>Cơ sở</th><th>Đơn</th><th>Tháng gốc</th><th>Lý do</th><th className="n">Số tiền</th></tr></thead>
            <tbody>
              {adjs.map((a) => (
                <tr key={a.id}>
                  <td>{names[a.propertyId] ?? a.propertyId}</td>
                  <td>{a.externalId ?? "—"}{a.channel ? <div className="small muted">{a.channel}</div> : null}</td>
                  <td>{D.formatMonthVN(a.originalMonth)}</td>
                  <td>{a.reason}</td>
                  <td className={`n ${sign(a.amount)}`}><b>{vnd(a.amount)}</b></td>
                </tr>
              ))}
              <tr className="total"><td colSpan={4}>Tổng điều chỉnh</td><td className={`n ${sign(adjs.reduce((t, a) => t + a.amount, 0))}`}>{vnd(adjs.reduce((t, a) => t + a.amount, 0))}</td></tr>
            </tbody>
          </table></div>
        </section>
      )}
      {can(user, "lockSettlement") && (
        <section className="panel" style={{ marginTop: 24 }}>
          {s.status !== "LOCKED" ? (
            <ActionForm action={lockAction} submit={`Khóa sổ ${D.formatMonthVN(month).toLowerCase()}`} okText="Đã khóa sổ" className="row">
              <input type="hidden" name="investorId" value={invId} /><input type="hidden" name="month" value={month} />
            </ActionForm>
          ) : (
            <ActionForm action={unlockAction} submit="Mở khóa" okText="Đã mở khóa">
              <input type="hidden" name="investorId" value={invId} /><input type="hidden" name="month" value={month} />
              <label className="field full"><span>Lý do mở khóa (bắt buộc)</span><input type="text" name="reason" id="reason" /></label>
            </ActionForm>
          )}
        </section>
      )}
      <section className="panel" style={{ marginTop: 24 }}>
        <header><div><h2>Hoàn vốn</h2><p>Tính trên các tháng đã khóa sổ</p></div><span className="pill ok">{pbPct}%</span></header>
        <div className="stack" style={{ gap: 8 }}>
          <div className="progress"><i style={{ width: `${pbPct}%` }} /></div>
          <div className="kv"><span>Vốn đầu tư</span><b>{vnd(pb.investmentTotal)}</b></div>
          <div className="kv"><span>Lợi nhuận đã thu về</span><b>{vnd(pb.received)}</b></div>
          <div className="kv"><span>Còn lại</span><b>{vnd(Math.max(0, pb.remaining))}</b></div>
          <div className="small muted">{pb.monthsLeft === null ? "Chưa đủ dữ liệu để ước tính thời gian hoàn vốn" : pb.monthsLeft === 0 ? "Đã hoàn vốn" : `Dự kiến còn khoảng ${pb.monthsLeft} tháng nữa`}</div>
        </div>
      </section>
    </>
  );
}
